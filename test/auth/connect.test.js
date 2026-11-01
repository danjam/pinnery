import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer } from '../helpers/server.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const REDIRECT = `https://${EXT_ID}.chromiumapp.org/`;
const verifierFor = () => crypto.randomBytes(32).toString('base64url');
const challengeFor = (v) => crypto.createHash('sha256').update(v).digest('base64url');

describe('extension connect flow', () => {
  let server, gina, verifier, challenge;
  const params = (over = {}) => ({
    redirect_uri: REDIRECT,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: 'state-123',
    name: 'My Chrome',
    ...over,
  });
  const query = (p) => '?' + new URLSearchParams(p).toString();
  const sameOrigin = { 'sec-fetch-site': 'same-origin' };
  const decide = (client, body, headers = sameOrigin) => client.json('/connect/decide', { method: 'POST', json: body, headers });
  const codeFrom = (redirect) => new URL(redirect).searchParams.get('code');
  const exchange = (body, ip = '127.0.0.60') => server.anon({ ip }).post('/api/connect/token', body);

  before(async () => {
    server = await startServer();
    gina = await server.createUser('gina@example.com', 'gina-password-1');
    verifier = verifierFor();
    challenge = challengeFor(verifier);
  });
  after(() => server.stop());

  it('GET /connect validates params (400 page) before anything else', async () => {
    const anon = server.anon();
    const bad = [
      params({ redirect_uri: 'https://evil.example.com/' }),
      params({ redirect_uri: 'http://' + EXT_ID + '.chromiumapp.org/' }),
      params({ redirect_uri: `https://${EXT_ID}.chromiumapp.org/?x=1` }),
      params({ redirect_uri: `https://short.chromiumapp.org/` }),
      params({ code_challenge_method: 'plain' }),
      params({ code_challenge: 'tooshort' }),
      params({ state: '' }),
      params({ state: 'has space' }),
    ];
    for (const p of bad) {
      const r = await anon.fetch('/connect' + query(p));
      assert.equal(r.status, 400, JSON.stringify(p));
      assert.match(await r.text(), /connect link is invalid/);
    }
    assert.equal((await anon.fetch('/connect')).status, 400);
  });

  it('GET /connect with valid params redirects signed-out users to login (keeping the params) and serves the page when signed in', async () => {
    const q = query(params());
    const r = await server.anon().fetch('/connect' + q);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `/login?next=${encodeURIComponent('/connect' + q)}`);
    const ok = await gina.fetch('/connect' + q);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
  });

  it('escapes nothing dangerous into the error page', async () => {
    const r = await server.anon().fetch('/connect' + query(params({ redirect_uri: '<script>alert(1)</script>' })));
    const text = await r.text();
    assert.equal(r.status, 400);
    assert.ok(!text.includes('<script>alert'));
  });

  it('/connect/decide needs a session, same-origin and valid params', async () => {
    assert.equal((await decide(server.anon(), { ...params(), allow: true })).status, 401);
    assert.equal((await decide(gina, { ...params(), allow: true }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await decide(gina, { ...params(), allow: true }, {})).status, 403);
    assert.equal((await decide(gina, { ...params(), allow: true }, { origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await decide(gina, { ...params({ redirect_uri: 'https://evil.example.com/' }), allow: true })).status, 400);
    // a matching Origin header is accepted when Sec-Fetch-Site is absent
    const r = await decide(gina, { ...params(), allow: true }, { origin: server.url });
    assert.equal(r.status, 200);
  });

  it('deny redirects back with access_denied and issues no code', async () => {
    const r = await decide(gina, { ...params(), allow: false });
    assert.equal(r.status, 200);
    const u = new URL(r.body.redirect);
    assert.equal(u.origin + u.pathname, REDIRECT);
    assert.equal(u.searchParams.get('error'), 'access_denied');
    assert.equal(u.searchParams.get('state'), 'state-123');
    assert.equal(u.searchParams.get('code'), null);
    // allow must be literally true
    const loose = await decide(gina, { ...params(), allow: 'true' });
    assert.equal(new URL(loose.body.redirect).searchParams.get('error'), 'access_denied');
  });

  it('allow then exchange yields a named token for that user, and the code is single-use', async () => {
    const r = await decide(gina, { ...params(), allow: true });
    assert.equal(r.status, 200);
    const u = new URL(r.body.redirect);
    assert.equal(u.searchParams.get('state'), 'state-123');
    const code = u.searchParams.get('code');
    assert.match(code, /^[0-9a-f]{64}$/);

    const ex = await exchange({ code, code_verifier: verifier, redirect_uri: REDIRECT });
    assert.equal(ex.status, 201);
    assert.match(ex.body.token, /^pn_/);
    assert.equal(ex.body.name, 'My Chrome');
    const viaToken = await server.bearer(ex.body.token).get('/api/me');
    assert.equal(viaToken.body.email, 'gina@example.com');
    assert.ok((await gina.get('/api/tokens')).body.some((t) => t.name === 'My Chrome'));

    const again = await exchange({ code, code_verifier: verifier, redirect_uri: REDIRECT });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'invalid or expired code');
  });

  it('a wrong verifier or redirect_uri fails and burns the code', async () => {
    const mk = async () => codeFrom((await decide(gina, { ...params(), allow: true })).body.redirect);

    const c1 = await mk();
    const badVerifier = await exchange({ code: c1, code_verifier: verifierFor(), redirect_uri: REDIRECT });
    assert.equal(badVerifier.status, 400);
    // even the correct verifier can't resurrect it
    assert.equal((await exchange({ code: c1, code_verifier: verifier, redirect_uri: REDIRECT })).status, 400);

    const c2 = await mk();
    const other = `https://${'p'.repeat(32)}.chromiumapp.org/`;
    assert.equal((await exchange({ code: c2, code_verifier: verifier, redirect_uri: other })).status, 400);
    assert.equal((await exchange({ code: c2, code_verifier: verifier, redirect_uri: REDIRECT })).status, 400);
  });

  it('rejects unknown, malformed and missing codes', async () => {
    assert.equal((await exchange({ code: 'f'.repeat(64), code_verifier: verifier, redirect_uri: REDIRECT })).status, 400);
    assert.equal((await exchange({ code: 'nope', code_verifier: verifier, redirect_uri: REDIRECT })).status, 400);
    assert.equal((await exchange({})).status, 400);
  });

  it('throttles failed exchanges per IP (429) without touching another IP', async () => {
    const ip = '127.0.0.61';
    for (let i = 0; i < 10; i++) {
      assert.equal((await exchange({ code: 'f'.repeat(64), code_verifier: verifier, redirect_uri: REDIRECT }, ip)).status, 400);
    }
    const code = codeFrom((await decide(gina, { ...params(), allow: true })).body.redirect);
    assert.equal((await exchange({ code, code_verifier: verifier, redirect_uri: REDIRECT }, ip)).status, 429);
    assert.equal((await exchange({ code, code_verifier: verifier, redirect_uri: REDIRECT }, '127.0.0.62')).status, 201);
    // separate from the login throttle
    assert.equal((await server.anon({ ip }).post('/api/login', { email: 'gina@example.com', password: 'gina-password-1' })).status, 200);
  });

  it('is refused while a password change is still required', async () => {
    // createUser() above already completed the admin's change, so use a fresh server.
    const fresh = await startServer();
    try {
      const c = await fresh.login('admin@example.com', 'initial-pass-1');
      const r = await decide(c, { ...params(), allow: true });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'password_change_required');
    } finally {
      await fresh.stop();
    }
  });
});
