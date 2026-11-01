import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

const EMAIL = 'proxy@example.com';
const PASSWORD = 'proxy-pass-1';

// Ten failed logins, each claiming a different client IP via X-Forwarded-For.
async function failFromFakeIps(server) {
  for (let i = 0; i < 10; i++) {
    const c = server.anon({ ip: `127.0.1.${i + 1}` });
    assert.equal((await c.post('/api/login', { email: EMAIL, password: `wrong-${i}` })).status, 401);
  }
}

const loginOverHttps = (server) => server.anon().fetch('/api/login', {
  method: 'POST',
  json: { email: EMAIL, password: PASSWORD },
  headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '127.0.2.1' },
});

describe('PINNERY_TRUST_PROXY unset (trusts one proxy)', () => {
  let server;
  before(async () => {
    server = await startServer();
    await server.createUser(EMAIL, PASSWORD);
  });
  after(() => server.stop());

  it('takes the client IP from X-Forwarded-For', async () => {
    await failFromFakeIps(server);
    // every attempt counted against a different IP, so this one still gets through
    const c = server.anon({ ip: '127.0.1.99' });
    assert.equal((await c.post('/api/login', { email: EMAIL, password: PASSWORD })).status, 200);
  });

  it('marks the session cookie Secure when the proxy says HTTPS', async () => {
    const res = await loginOverHttps(server);
    assert.equal(res.status, 200);
    assert.match(res.headers.getSetCookie()[0], /;\s*Secure/);
  });
});

describe('PINNERY_TRUST_PROXY=false', () => {
  let server;
  before(async () => {
    server = await startServer({ env: { PINNERY_TRUST_PROXY: 'false' } });
    await server.createUser(EMAIL, PASSWORD);
  });
  after(() => server.stop());

  it('ignores X-Forwarded-For, so faked IPs share one throttle', async () => {
    await failFromFakeIps(server);
    const c = server.anon({ ip: '127.0.1.99' });
    assert.equal((await c.post('/api/login', { email: EMAIL, password: PASSWORD })).status, 429);
  });

  it('ignores X-Forwarded-Proto for the cookie', async (t) => {
    // the throttle above now blocks 127.0.0.1, so start clean
    const fresh = await startServer({ env: { PINNERY_TRUST_PROXY: 'false' } });
    t.after(() => fresh.stop());
    await fresh.createUser(EMAIL, PASSWORD);
    const res = await loginOverHttps(fresh);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.headers.getSetCookie()[0], /;\s*Secure/);
  });
});
