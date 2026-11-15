import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.ts';
import type { Server } from '../helpers/server.ts';
import { CLIENT_ID, CLIENT_SECRET, startIdp } from '../helpers/idp.ts';
import type { Identity } from '../helpers/idp.ts';

type Idp = Awaited<ReturnType<typeof startIdp>>;

// One browser's trip through SSO: /auth/oidc/start, the provider, then the callback with the state
// cookie start set. Returns the callback's response (a redirect) and the session cookie, if any.
async function signIn(server: Server, idp: Idp, identity: Identity, { next, tamper }: { next?: string; tamper?: (u: URL) => void } = {}) {
  const start = await fetch(`${server.url}/auth/oidc/start${next ? `?next=${encodeURIComponent(next)}` : ''}`, { redirect: 'manual' });
  assert.equal(start.status, 302, await start.text());
  const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith('pinnery_oidc='))!.split(';')[0];
  const code = idp.authorize(start.headers.get('location')!, identity);
  const back = new URL(`${server.url}/auth/oidc/callback`);
  back.searchParams.set('code', code);
  back.searchParams.set('state', new URL(start.headers.get('location')!).searchParams.get('state')!);
  tamper?.(back);
  const res = await fetch(back, { redirect: 'manual', headers: { cookie: stateCookie } });
  const session = res.headers.getSetCookie().find((c) => /^pinnery_session=[^;]/.test(c))?.split(';')[0] ?? null;
  return { res, location: res.headers.get('location'), session };
}

const me = async (server: Server, cookie: string) => (await (await fetch(`${server.url}/api/me`, { headers: { cookie } })).json()) as { email: string };

describe('SSO sign-in (OIDC)', () => {
  let server: Server, idp: Idp;
  before(async () => {
    idp = await startIdp();
    server = await startServer({
      env: (url) => ({
        PINNERY_PUBLIC_URL: url,
        PINNERY_OIDC_ISSUER: idp.issuer,
        PINNERY_OIDC_CLIENT_ID: CLIENT_ID,
        PINNERY_OIDC_CLIENT_SECRET: CLIENT_SECRET,
        PINNERY_OIDC_NAME: 'Test ID',
      }),
    });
    await server.createUser('grace@example.com', 'grace-password-1');
    await server.createUser('heidi@example.com', 'heidi-password-1');
    await server.createUser('ivan@example.com', 'ivan-password-1');
  });
  after(async () => {
    await server.stop();
    await idp.close();
  });

  it('tells the login page about it', async () => {
    assert.deepEqual((await server.anon().get('/api/oidc')).body, { enabled: true, name: 'Test ID' });
  });

  it('links a verified email on first sign-in, and signs in by subject after', async () => {
    const first = await signIn(server, idp, { sub: 'grace-sub', email: 'Grace@Example.com', email_verified: true });
    assert.equal(first.location, '/');
    assert.ok(first.session);
    assert.equal((await me(server, first.session)).email, 'grace@example.com');
    assert.equal(first.res.headers.get('cache-control'), 'no-store');
    assert.equal(first.res.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(first.res.headers.getSetCookie().some((c) => /^pinnery_oidc=;/.test(c)), 'state cookie cleared');
    // The provider's email changes: the subject still finds her.
    const again = await signIn(server, idp, { sub: 'grace-sub', email: 'grace@elsewhere.example', email_verified: false });
    assert.ok(again.session);
    assert.equal((await me(server, again.session)).email, 'grace@example.com');
  });

  it('keeps ?next=, and drops one that leaves the site', async () => {
    assert.equal((await signIn(server, idp, { sub: 'grace-sub' }, { next: '/settings' })).location, '/settings');
    assert.equal((await signIn(server, idp, { sub: 'grace-sub' }, { next: '//evil.example/x' })).location, '/');
  });

  it('refuses an unverified email', async () => {
    const r = await signIn(server, idp, { sub: 'heidi-sub', email: 'heidi@example.com', email_verified: false });
    assert.equal(r.location, '/login?error=sso_unverified');
    assert.equal(r.session, null);
  });

  it('refuses someone with no account (no sign-up by SSO)', async () => {
    const r = await signIn(server, idp, { sub: 'mallory-sub', email: 'mallory@example.com', email_verified: true });
    assert.equal(r.location, '/login?error=sso_no_account');
    assert.equal(r.session, null);
  });

  it("won't link a user already linked to another subject", async () => {
    const r = await signIn(server, idp, { sub: 'someone-else', email: 'grace@example.com', email_verified: true });
    assert.equal(r.location, '/login?error=sso_no_account');
  });

  it('reads the email from userinfo when the ID token lacks it', async () => {
    const r = await signIn(server, idp, { sub: 'ivan-sub', email: 'ivan@example.com', email_verified: true, emailInUserinfoOnly: true });
    assert.ok(r.session);
    assert.equal((await me(server, r.session)).email, 'ivan@example.com');
  });

  it('reads email_verified from userinfo when the ID token has only the email', async () => {
    const r = await signIn(server, idp, { sub: 'heidi-sub', email: 'heidi@example.com', email_verified: true, verifiedInUserinfoOnly: true });
    assert.ok(r.session);
    assert.equal((await me(server, r.session)).email, 'heidi@example.com');
  });

  it('refuses a mismatched state or nonce', async () => {
    const state = await signIn(server, idp, { sub: 'grace-sub' }, { tamper: (u) => u.searchParams.set('state', 'f'.repeat(64)) });
    assert.equal(state.location, '/login?error=sso_failed');
    const nonce = await signIn(server, idp, { sub: 'grace-sub', nonce: 'not-the-nonce' });
    assert.equal(nonce.location, '/login?error=sso_failed');
    assert.equal(nonce.session, null);
  });

  it('refuses a callback without the state cookie, or used twice', async () => {
    const start = await fetch(`${server.url}/auth/oidc/start`, { redirect: 'manual' });
    const cookie = start.headers.getSetCookie().find((c) => c.startsWith('pinnery_oidc='))!.split(';')[0];
    const loc = start.headers.get('location')!;
    const back = `${server.url}/auth/oidc/callback?code=${idp.authorize(loc, { sub: 'grace-sub' })}&state=${new URL(loc).searchParams.get('state')}`;
    assert.equal((await fetch(back, { redirect: 'manual' })).headers.get('location'), '/login?error=sso_failed');
    assert.equal((await fetch(back, { redirect: 'manual', headers: { cookie } })).headers.get('location'), '/');
    assert.equal((await fetch(back, { redirect: 'manual', headers: { cookie } })).headers.get('location'), '/login?error=sso_failed');
  });

  it('passes on the provider refusing', async () => {
    const r = await signIn(server, idp, { sub: 'grace-sub' }, { tamper: (u) => { u.searchParams.delete('code'); u.searchParams.set('error', 'access_denied'); } });
    assert.equal(r.location, '/login?error=sso_failed');
  });

  it('leaves password sign-in working for a linked user', async () => {
    await server.login('grace@example.com', 'grace-password-1');
  });
});

describe('SSO sign-in while a password change is required', () => {
  let server: Server, idp: Idp;
  before(async () => {
    idp = await startIdp();
    server = await startServer({
      env: (url) => ({ PINNERY_PUBLIC_URL: url, PINNERY_OIDC_ISSUER: idp.issuer, PINNERY_OIDC_CLIENT_ID: CLIENT_ID, PINNERY_OIDC_CLIENT_SECRET: CLIENT_SECRET }),
    });
  });
  after(async () => {
    await server.stop();
    await idp.close();
  });

  it('signs in, then sends the user to choose a password like a password sign-in would', async () => {
    // The seeded admin, never signed in: their PINNERY_PASSWORD must still be changed.
    const r = await signIn(server, idp, { sub: 'admin-sub', email: server.adminEmail, email_verified: true }, { next: '/settings' });
    assert.equal(r.location, '/settings');
    assert.ok(r.session);
    const page = await fetch(`${server.url}/settings`, { redirect: 'manual', headers: { cookie: r.session } });
    assert.equal(page.headers.get('location'), '/password?next=%2Fsettings');
    assert.equal((await fetch(`${server.url}/api/me`, { headers: { cookie: r.session } })).status, 403);
  });
});

describe('SSO sign-in when not configured', () => {
  let server: Server;
  before(async () => { server = await startServer({ env: { PINNERY_OIDC_ISSUER: 'https://id.example.com', PINNERY_OIDC_CLIENT_ID: 'x' } }); });
  after(() => server.stop());

  it('is off without PINNERY_PUBLIC_URL, and says so', async () => {
    assert.deepEqual((await server.anon().get('/api/oidc')).body, { enabled: false });
    assert.equal((await server.anon().fetch('/auth/oidc/start')).status, 404);
    assert.equal((await server.anon().fetch('/auth/oidc/callback?code=x&state=y')).status, 404);
    assert.match(server.output(), /PINNERY_PUBLIC_URL is not set, so SSO sign-in is off/);
  });
});

describe('SSO sign-in with the provider down', () => {
  let server: Server;
  before(async () => {
    server = await startServer({ env: (url) => ({ PINNERY_PUBLIC_URL: url, PINNERY_OIDC_ISSUER: 'http://127.0.0.1:9', PINNERY_OIDC_CLIENT_ID: 'x' }) });
  });
  after(() => server.stop());

  it('still starts, and sends sign-ins back to the login page', async () => {
    const r = await server.anon().fetch('/auth/oidc/start');
    assert.equal(r.headers.get('location'), '/login?error=sso_unavailable');
  });
});
