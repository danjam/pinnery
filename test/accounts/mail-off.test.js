import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.ts';
import { tokenFromLink } from '../helpers/mail.ts';
import { userByEmail } from '../helpers/accounts.ts';

describe('accounts (mail off)', () => {
  let server, admin;
  before(async () => {
    server = await startServer();
    admin = await server.adminClient();
  });
  after(() => server.stop());

  it('reports mail disabled', async () => {
    assert.deepEqual((await server.anon().get('/api/mail')).body, { enabled: false, reset: false });
  });

  it('invites return the link for copying and it works', async () => {
    const { status, body } = await admin.post('/api/invites', { email: 'copy@example.com' });
    assert.equal(status, 201);
    assert.equal(body.sent, false);
    assert.match(body.link, /\/signup\/[0-9a-f]{64}$/);
    const anon = server.anon();
    assert.deepEqual((await anon.get(`/api/signup/${tokenFromLink(body.link)}`)).body, { email: 'copy@example.com' });
    assert.equal((await anon.post(`/api/signup/${tokenFromLink(body.link)}`, { display_name: 'Copy', password: 'copy-pass-123' })).status, 201);
    assert.equal((await anon.get('/api/me')).body.email, 'copy@example.com');
  });

  it('admin reset link is returned for copying and works', async () => {
    const u = await server.createUser('jo@example.com', 'jo-pass-12345');
    const ju = await userByEmail(admin, 'jo@example.com');
    const res = await admin.post(`/api/users/${ju.id}/reset`);
    assert.equal(res.status, 201);
    assert.equal(res.body.sent, false);
    assert.match(res.body.link, /\/reset\/[0-9a-f]{64}$/);
    const anon = server.anon({ ip: '127.0.0.60' });
    assert.equal((await anon.post(`/api/reset/${tokenFromLink(res.body.link)}`, { password: 'jo-new-pass-12' })).status, 200);
    assert.equal((await u.get('/api/me')).status, 401);
    await server.login('jo@example.com', 'jo-new-pass-12', { ip: '127.0.0.61' });
  });

  it('forgot password does nothing but says mail is off; email change is unavailable', async () => {
    const forgot = await server.anon({ ip: '127.0.0.62' }).post('/api/forgot', { email: 'jo@example.com' });
    assert.deepEqual(forgot.body, { ok: true, mail: false });
    const jo = await server.login('jo@example.com', 'jo-new-pass-12', { ip: '127.0.0.63' });
    const res = await jo.post('/api/email', { email: 'jo2@example.com', password: 'jo-new-pass-12' });
    assert.equal(res.status, 409);
    assert.equal((await jo.get('/api/me')).body.email, 'jo@example.com');
  });
});
