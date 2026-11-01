import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.ts';
import type { Client, Server } from '../helpers/server.ts';

const cookieRe = /^pinnery_session=[0-9a-f]{64}/;

// Failed credential checks (shared budget of 10 per IP) always use their own IP so tests don't
// eat each other's budget.
describe('login and logout', () => {
  let server: Server, alice: Client;
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
    assert.match(set ?? '', cookieRe);
    assert.match(set ?? '', /HttpOnly/);
    assert.match(set ?? '', /SameSite=Lax/);
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
    assert.match(res.headers.getSetCookie().find((x) => x.startsWith('pinnery_session=')) ?? '', /Max-Age=0/);
    assert.equal(c.cookie(), null);
    assert.equal((await c.get('/api/me')).status, 401);
    // the old cookie value is dead server-side, not just forgotten by the client
    const replay = await server.anon().json('/api/me', { headers: { cookie: old! } });
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
