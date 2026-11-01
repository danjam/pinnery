import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.ts';

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
