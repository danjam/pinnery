import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer } from './helpers/server.js';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const REDIRECT = `https://${EXT_ID}.chromiumapp.org/`;
const verifierFor = () => crypto.randomBytes(32).toString('base64url');
const challengeFor = (v) => crypto.createHash('sha256').update(v).digest('base64url');
const cookieRe = /^pinnery_session=[0-9a-f]{64}/;

// Failed credential checks (shared budget of 10 per IP) always use their own IP so tests don't
// eat each other's budget.
describe('login and logout', () => {
  let server, alice;
  before(async () => {
    server = await startServer();
    alice = await server.createUser('alice@example.com', 'alice-password-1');
  });
  after(() => server.stop());

  it('logs in with correct credentials and sets an HttpOnly session cookie', async () => {
    const c = server.anon({ ip: '127.0.0.10' });
    const { status, body, res } = await c.post('/api/login', { email: 'alice@example.com', password: 'alice-password-1' });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    const set = res.headers.getSetCookie().find((x) => x.startsWith('pinnery_session='));
    assert.match(set, cookieRe);
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Lax/);
    assert.equal((await c.get('/api/me')).body.email, 'alice@example.com');
  });

  it('matches the email case-insensitively and ignores surrounding whitespace', async () => {
    const c = server.anon({ ip: '127.0.0.10' });
    const { status } = await c.post('/api/login', { email: '  Alice@Example.com ', password: 'alice-password-1' });
    assert.equal(status, 200);
  });

  it('accepts a form-encoded login too', async () => {
    const c = server.anon({ ip: '127.0.0.10' });
    const res = await c.fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'alice@example.com', password: 'alice-password-1' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await c.get('/api/me')).status, 200);
  });

  it('wrong password and unknown email give the same 401 answer', async () => {
    const c = server.anon({ ip: '127.0.0.11' });
    const wrong = await c.post('/api/login', { email: 'alice@example.com', password: 'nope-nope-nope' });
    const unknown = await c.post('/api/login', { email: 'nobody@example.com', password: 'alice-password-1' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.equal(wrong.res.headers.getSetCookie().length, 0);
    assert.equal((await c.get('/api/me')).status, 401);
  });

  it('missing or non-string fields are just a failed login', async () => {
    const c = server.anon({ ip: '127.0.0.12' });
    assert.equal((await c.post('/api/login', {})).status, 401);
    assert.equal((await c.post('/api/login', { email: 'alice@example.com', password: 12345678 })).status, 401);
    assert.equal((await c.post('/api/login', { email: ['alice@example.com'], password: 'x' })).status, 401);
  });

  it('logout ends the session and clears the cookie', async () => {
    const c = await server.login('alice@example.com', 'alice-password-1', { ip: '127.0.0.13' });
    const old = c.cookie();
    assert.equal((await c.get('/api/me')).status, 200);
    const { status, res } = await c.post('/api/logout');
    assert.equal(status, 200);
    assert.match(res.headers.getSetCookie().find((x) => x.startsWith('pinnery_session=')), /Max-Age=0/);
    assert.equal(c.cookie(), null);
    assert.equal((await c.get('/api/me')).status, 401);
    // the old cookie value is dead server-side, not just forgotten by the client
    const replay = await server.anon().json('/api/me', { headers: { cookie: old } });
    assert.equal(replay.status, 401);
  });

  it('logout while signed out is harmless', async () => {
    assert.equal((await server.anon().post('/api/logout')).status, 200);
  });

  it('logout only ends that session, not the user\'s others', async () => {
    const a = await server.login('alice@example.com', 'alice-password-1', { ip: '127.0.0.14' });
    const b = await server.login('alice@example.com', 'alice-password-1', { ip: '127.0.0.14' });
    await a.post('/api/logout');
    assert.equal((await b.get('/api/me')).status, 200);
  });

  it('malformed JSON gets a 400', async () => {
    const res = await server.anon().fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(res.status, 400);
  });

  it('createUser client is non-admin', async () => {
    assert.equal((await alice.get('/api/me')).body.is_admin, false);
  });
});

describe('login throttle', () => {
  let server;
  before(async () => {
    server = await startServer();
    await server.createUser('throttle@example.com', 'throttle-pass-1');
  });
  after(() => server.stop());

  it('answers 429 after 10 failures, even for the right password, and spares other IPs', async () => {
    const bad = server.anon({ ip: '127.0.0.20' });
    for (let i = 0; i < 10; i++) {
      assert.equal((await bad.post('/api/login', { email: 'throttle@example.com', password: `wrong-${i}` })).status, 401);
    }
    const locked = await bad.post('/api/login', { email: 'throttle@example.com', password: 'throttle-pass-1' });
    assert.equal(locked.status, 429);
    assert.equal(locked.res.headers.getSetCookie().length, 0);
    // the lockout is per IP, never per account
    const other = await server.login('throttle@example.com', 'throttle-pass-1', { ip: '127.0.0.21' });
    assert.equal((await other.get('/api/me')).status, 200);
  });

  it('shares the budget with POST /api/tokens', async () => {
    const c = server.anon({ ip: '127.0.0.22' });
    for (let i = 0; i < 10; i++) {
      assert.equal((await c.post('/api/tokens', { email: 'throttle@example.com', password: 'bad', name: 'x' })).status, 401);
    }
    assert.equal((await c.post('/api/login', { email: 'throttle@example.com', password: 'throttle-pass-1' })).status, 429);
  });

  it('successful logins do not count against the budget', async () => {
    const c = server.anon({ ip: '127.0.0.23' });
    for (let i = 0; i < 12; i++) {
      assert.equal((await c.post('/api/login', { email: 'throttle@example.com', password: 'throttle-pass-1' })).status, 200);
    }
  });
});

describe('first-login password change gate', () => {
  let server;
  before(async () => { server = await startServer({ mail: true }); });
  after(() => server.stop());

  it('closes the API and pages until the password is changed, then opens them', async () => {
    const c = await server.login('admin@example.com', 'initial-pass-1', { ip: '127.0.0.30' });
    for (const [method, path] of [['GET', '/api/me'], ['GET', '/api/invites'], ['GET', '/api/tokens'], ['GET', '/api/boards']]) {
      const { status, body } = await c.json(path, { method });
      assert.equal(status, 403, path);
      assert.equal(body.code, 'password_change_required', path);
    }
    // pages go to the change page
    const home = await c.fetch('/');
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/password?next=%2F');
    // /password itself is reachable
    assert.equal((await c.fetch('/password')).status, 200);
    // /login while signed in but gated sends you to /password, carrying next
    const login = await c.fetch('/login?next=/settings');
    assert.equal(login.headers.get('location'), '/password?next=%2Fsettings');
    // tokens cannot be minted for a gated account
    const t = await server.anon({ ip: '127.0.0.31' }).post('/api/tokens', { email: 'admin@example.com', password: 'initial-pass-1', name: 'x' });
    assert.equal(t.status, 403);
    assert.equal(t.body.code, 'password_change_required');
    // logout still works
    assert.equal((await c.post('/api/logout')).status, 200);
  });

  it('a too-short new password is refused and the gate stays', async () => {
    const c = await server.login('admin@example.com', 'initial-pass-1', { ip: '127.0.0.32' });
    const r = await c.post('/api/password', { current: 'initial-pass-1', new: 'short' });
    assert.equal(r.status, 400);
    assert.equal((await c.get('/api/me')).status, 403);
  });

  it('changing the password clears the gate; the old one stops working', async () => {
    const c = await server.login('admin@example.com', 'initial-pass-1', { ip: '127.0.0.33' });
    const r = await c.post('/api/password', { current: 'initial-pass-1', new: 'admin-pass-changed-1' });
    assert.equal(r.status, 200);
    const me = await c.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.must_change_password, false);
    assert.equal((await c.fetch('/')).status, 200);
    const ip = '127.0.0.34';
    assert.equal((await server.anon({ ip }).post('/api/login', { email: 'admin@example.com', password: 'initial-pass-1' })).status, 401);
    assert.equal((await server.login('admin@example.com', 'admin-pass-changed-1', { ip })).cookie() !== null, true);
  });
});

describe('voluntary password change', () => {
  let server, bob, other, token;
  before(async () => {
    server = await startServer({ mail: true });
    bob = await server.createUser('bob@example.com', 'bob-password-1');
    other = await server.login('bob@example.com', 'bob-password-1', { ip: '127.0.0.40' });
    token = await bob.mintToken('keep-me');
  });
  after(() => server.stop());

  it('refuses a wrong current password with 403 and leaves everything intact', async () => {
    const r = await bob.post('/api/password', { current: 'not-it-at-all', new: 'bob-password-2' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'wrong password');
    assert.equal((await bob.get('/api/me')).status, 200);
    assert.equal((await server.login('bob@example.com', 'bob-password-1', { ip: '127.0.0.41' })).cookie() !== null, true);
  });

  it('requires a browser session, not a bearer token or nothing', async () => {
    assert.equal((await server.bearer(token).post('/api/password', { current: 'bob-password-1', new: 'bob-password-2' })).status, 401);
    assert.equal((await server.anon().post('/api/password', { current: 'bob-password-1', new: 'bob-password-2' })).status, 401);
    // and the password really is unchanged
    assert.equal((await server.login('bob@example.com', 'bob-password-1', { ip: '127.0.0.42' })).cookie() !== null, true);
  });

  it('rejects a too-short new password', async () => {
    const r = await bob.post('/api/password', { current: 'bob-password-1', new: 'short' });
    assert.equal(r.status, 400);
  });

  it('changes the password, keeps this session and API tokens, signs other browsers out, mails a notice', async () => {
    assert.equal((await other.get('/api/me')).status, 200);
    const r = await bob.post('/api/password', { current: 'bob-password-1', new: 'bob-password-2' });
    assert.equal(r.status, 200);
    assert.equal((await bob.get('/api/me')).status, 200);
    assert.equal((await other.get('/api/me')).status, 401);
    assert.equal((await server.bearer(token).get('/api/me')).status, 200);
    // old password dead, new one works
    const ip = '127.0.0.43';
    assert.equal((await server.anon({ ip }).post('/api/login', { email: 'bob@example.com', password: 'bob-password-1' })).status, 401);
    assert.equal((await server.anon({ ip }).post('/api/login', { email: 'bob@example.com', password: 'bob-password-2' })).status, 200);
    const mail = await server.mail.waitFor((m) => m.to.includes('bob@example.com') && /password was changed/i.test(m.subject));
    assert.ok(mail);
  });
});

describe('API tokens', () => {
  let server, carol, dave;
  before(async () => {
    server = await startServer({ mail: true });
    carol = await server.createUser('carol@example.com', 'carol-password-1');
    dave = await server.createUser('dave@example.com', 'dave-password-1');
  });
  after(() => server.stop());

  it('issues a named pn_ token, lists it without the secret, and it authenticates', async () => {
    const { status, body } = await carol.post('/api/tokens', { email: 'carol@example.com', password: 'carol-password-1', name: '  laptop  ' });
    assert.equal(status, 201);
    assert.match(body.token, /^pn_[0-9a-f]{64}$/);
    assert.equal(body.name, 'laptop');
    const list = await carol.get('/api/tokens');
    assert.equal(list.status, 200);
    const row = list.body.find((t) => t.id === body.id);
    assert.equal(row.name, 'laptop');
    assert.ok(!JSON.stringify(list.body).includes(body.token));
    assert.equal(row.current, false);
    const viaToken = await server.bearer(body.token).get('/api/me');
    assert.equal(viaToken.body.email, 'carol@example.com');
    // the token's own listing marks it as current
    const own = await server.bearer(body.token).get('/api/tokens');
    assert.equal(own.body.find((t) => t.id === body.id).current, true);
    assert.ok((await carol.get('/api/tokens')).body.find((t) => t.id === body.id).last_used_at);
  });

  it('requires a name and valid credentials', async () => {
    const c = server.anon({ ip: '127.0.0.50' });
    assert.equal((await c.post('/api/tokens', { email: 'carol@example.com', password: 'carol-password-1', name: '   ' })).status, 400);
    assert.equal((await c.post('/api/tokens', { email: 'carol@example.com', password: 'carol-password-1' })).status, 400);
    assert.equal((await c.post('/api/tokens', { email: 'carol@example.com', password: 'wrong', name: 'x' })).status, 401);
  });

  it('revoking one token kills only that token', async () => {
    const t1 = await carol.mintToken('one');
    const t2 = await carol.mintToken('two');
    const list = (await carol.get('/api/tokens')).body;
    const id1 = list.find((t) => t.name === 'one').id;
    const r = await carol.del(`/api/tokens/${id1}`);
    assert.equal(r.status, 200);
    assert.equal((await server.bearer(t1).get('/api/me')).status, 401);
    assert.equal((await server.bearer(t2).get('/api/me')).status, 200);
    assert.equal((await carol.del(`/api/tokens/${id1}`)).status, 404);
    assert.equal((await carol.del('/api/tokens/abc')).status, 404);
  });

  it("cannot revoke another user's token, and sessions are not listed as tokens", async () => {
    const t = await dave.mintToken('dave-only');
    const id = (await dave.get('/api/tokens')).body.find((x) => x.name === 'dave-only').id;
    assert.equal((await carol.del(`/api/tokens/${id}`)).status, 404);
    assert.equal((await server.bearer(t).get('/api/me')).status, 200);
    assert.ok(!(await carol.get('/api/tokens')).body.some((x) => x.id === id));
    // a browser session row is not revocable through the tokens route
    const { body: me } = await dave.get('/api/tokens');
    assert.ok(me.every((x) => x.name));
  });

  it('revoke all removes every token of the caller, not other users\' or the session', async () => {
    const a = await carol.mintToken('a');
    const b = await carol.mintToken('b');
    const d = await dave.mintToken('d2');
    const r = await carol.del('/api/tokens');
    assert.equal(r.status, 200);
    assert.ok(r.body.revoked >= 2);
    assert.equal((await server.bearer(a).get('/api/me')).status, 401);
    assert.equal((await server.bearer(b).get('/api/me')).status, 401);
    assert.deepEqual((await carol.get('/api/tokens')).body, []);
    assert.equal((await carol.get('/api/me')).status, 200);
    assert.equal((await server.bearer(d).get('/api/me')).status, 200);
  });

  it('a bearer token cannot change the password or email, nor mint more tokens without credentials', async () => {
    const t = await carol.mintToken('limited');
    const bearer = server.bearer(t);
    assert.equal((await bearer.post('/api/password', { current: 'carol-password-1', new: 'carol-password-2' })).status, 401);
    const email = await bearer.post('/api/email', { email: 'new@example.com', password: 'carol-password-1' });
    assert.equal(email.status, 403);
    assert.equal((await server.anon().post('/api/tokens', {})).status, 401);
    // nothing changed
    assert.equal((await server.login('carol@example.com', 'carol-password-1', { ip: '127.0.0.51' })).cookie() !== null, true);
  });

  it('bogus and malformed bearer values are 401', async () => {
    assert.equal((await server.bearer('pn_' + '0'.repeat(64)).get('/api/me')).status, 401);
    assert.equal((await server.anon().get('/api/me', { headers: { authorization: 'Bearer ' } })).status, 401);
    assert.equal((await server.anon().get('/api/tokens')).status, 401);
    assert.equal((await server.anon().del('/api/tokens')).status, 401);
  });
});

describe('/api/me and admin-only routes', () => {
  let server, erin, admin;
  before(async () => {
    server = await startServer();
    admin = await server.adminClient();
    erin = await server.createUser('erin@example.com', 'erin-password-1', { displayName: 'Erin' });
  });
  after(() => server.stop());

  it('GET /api/me describes the caller without leaking the hash', async () => {
    const { status, body } = await erin.get('/api/me');
    assert.equal(status, 200);
    assert.equal(body.email, 'erin@example.com');
    assert.equal(body.display_name, 'Erin');
    assert.equal(body.is_admin, false);
    assert.equal(body.must_change_password, false);
    assert.ok(!('password_hash' in body));
    assert.equal((await admin.get('/api/me')).body.is_admin, true);
  });

  it('PATCH /api/me renames, trims, and validates', async () => {
    const r = await erin.patch('/api/me', { display_name: '  Erin J  ' });
    assert.equal(r.status, 200);
    assert.equal(r.body.display_name, 'Erin J');
    assert.equal((await erin.get('/api/me')).body.display_name, 'Erin J');
    assert.equal((await erin.patch('/api/me', { display_name: '   ' })).status, 400);
    assert.equal((await erin.patch('/api/me', { display_name: 'x'.repeat(101) })).status, 400);
    assert.equal((await erin.patch('/api/me', { display_name: 42 })).status, 400);
    assert.equal((await erin.get('/api/me')).body.display_name, 'Erin J');
    assert.equal((await server.anon().patch('/api/me', { display_name: 'x' })).status, 401);
  });

  it('refuses admin routes for a normal user and allows them for the admin', async () => {
    assert.equal((await erin.get('/api/invites')).status, 403);
    assert.equal((await erin.post('/api/invites', { email: 'x@example.com' })).status, 403);
    assert.equal((await erin.del('/api/invites/1')).status, 403);
    assert.equal((await erin.get('/api/users')).status, 403);
    assert.equal((await server.anon().get('/api/invites')).status, 401);
    assert.equal((await server.anon().get('/api/users')).status, 401);
    assert.equal((await admin.get('/api/invites')).status, 200);
    assert.equal((await admin.get('/api/users')).status, 200);
  });

  it('a bearer token carries the user\'s admin-ness, no more', async () => {
    const t = await erin.mintToken('e');
    assert.equal((await server.bearer(t).get('/api/invites')).status, 403);
    const at = await admin.mintToken('a');
    assert.equal((await server.bearer(at).get('/api/invites')).status, 200);
  });
});

describe('page routes and ?next', () => {
  let server, frank;
  before(async () => {
    server = await startServer();
    frank = await server.createUser('frank@example.com', 'frank-password-1');
  });
  after(() => server.stop());

  it('sends signed-out visitors to /login with next', async () => {
    const root = await server.anon().fetch('/');
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/login?next=%2F');
    const settings = await server.anon().fetch('/settings');
    assert.equal(settings.status, 302);
    assert.equal(settings.headers.get('location'), '/login?next=%2Fsettings');
    const tab = await server.anon().fetch('/settings/users?x=1');
    assert.equal(tab.headers.get('location'), '/login?next=' + encodeURIComponent('/settings/users?x=1'));
  });

  it('serves the app to signed-in users', async () => {
    assert.equal((await frank.fetch('/')).status, 200);
    assert.equal((await frank.fetch('/settings')).status, 200);
  });

  it('serves the login page when signed out', async () => {
    const r = await server.anon().fetch('/login');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /html/);
  });

  it('/login redirects signed-in users to next or home', async () => {
    assert.equal((await frank.fetch('/login')).headers.get('location'), '/');
    assert.equal((await frank.fetch('/login?next=/settings')).headers.get('location'), '/settings');
  });

  it('safeNext rejects off-site targets', async () => {
    for (const bad of ['https://evil.example.com/', '//evil.example.com', '/\\evil.example.com', 'javascript:alert(1)', 'evil', '/' + 'a'.repeat(2100)]) {
      const r = await frank.fetch(`/login?next=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 302, bad);
      assert.equal(r.headers.get('location'), '/', bad);
    }
    // repeated param (array) is ignored too
    assert.equal((await frank.fetch('/login?next=/a&next=/b')).headers.get('location'), '/');
  });

  it('static assets and healthz need no session', async () => {
    assert.equal((await server.anon().fetch('/healthz')).status, 200);
    assert.equal((await server.anon().fetch('/manifest.webmanifest')).status, 200);
  });

  it('unknown API paths are JSON 404 (signed in) and unknown pages are text 404', async () => {
    const r = await frank.get('/api/definitely-not-a-thing');
    assert.equal(r.status, 404);
    assert.equal((await server.anon().fetch('/nope')).status, 404);
  });
});

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
