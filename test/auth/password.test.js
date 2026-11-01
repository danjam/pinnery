import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

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
