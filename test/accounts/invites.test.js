import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.ts';
import { linkFrom, tokenFromLink } from '../helpers/mail.ts';
import { BAD_TOKEN, expireLink } from '../helpers/accounts.ts';

describe('accounts (mail on)', () => {
  let server, admin;
  before(async () => {
    server = await startServer({ mail: true });
    admin = await server.adminClient();
  });
  after(() => server.stop());

  it('reports mail enabled', async () => {
    assert.deepEqual((await server.anon().get('/api/mail')).body, { enabled: true, reset: true });
  });

  describe('invites and signup', () => {
    it('only admins can manage invites', async () => {
      const u = await server.createUser('plain@example.com', 'plain-pass-1');
      assert.equal((await u.get('/api/invites')).status, 403);
      assert.equal((await u.post('/api/invites', { email: 'x@example.com' })).status, 403);
      assert.equal((await server.anon().get('/api/invites')).status, 401);
    });

    it('invite is emailed with a working link, listed, and single-use', async () => {
      const { status, body } = await admin.post('/api/invites', { email: 'Invitee@Example.com' });
      assert.equal(status, 201);
      assert.equal(body.email, 'invitee@example.com');
      assert.equal(body.sent, true);
      const mail = await server.mail.waitFor((m) => m.to.includes('invitee@example.com'));
      const link = linkFrom(mail, '/signup/');
      assert.equal(link, body.link);

      const list = await admin.get('/api/invites');
      assert.ok(list.body.some((i) => i.id === body.id && i.email === 'invitee@example.com'));

      const token = tokenFromLink(link);
      const anon = server.anon();
      assert.deepEqual((await anon.get(`/api/signup/${token}`)).body, { email: 'invitee@example.com' });

      // validation failures don't burn the invite
      assert.equal((await anon.post(`/api/signup/${token}`, { display_name: '', password: 'long-enough-1' })).status, 400);
      assert.equal((await anon.post(`/api/signup/${token}`, { display_name: 'Inv', password: 'short' })).status, 400);

      const signup = await anon.post(`/api/signup/${token}`, { display_name: 'Inv', password: 'invitee-pass-1' });
      assert.equal(signup.status, 201);
      const me = await anon.get('/api/me');
      assert.equal(me.body.email, 'invitee@example.com');
      assert.equal(me.body.display_name, 'Inv');
      assert.equal(me.body.is_admin, false);

      // consumed: gone from the list, link dead, password works
      assert.ok(!(await admin.get('/api/invites')).body.some((i) => i.id === body.id));
      assert.equal((await server.anon({ ip: '127.0.0.20' }).get(`/api/signup/${token}`)).status, 404);
      assert.equal((await server.anon({ ip: '127.0.0.20' }).post(`/api/signup/${token}`, { display_name: 'Again', password: 'another-pass-1' })).status, 404);
      await server.login('invitee@example.com', 'invitee-pass-1', { ip: '127.0.0.21' });
    });

    it('cancelled invites stop working', async () => {
      const { body } = await admin.post('/api/invites', { email: 'cancelled@example.com' });
      const token = tokenFromLink(body.link);
      assert.equal((await admin.del(`/api/invites/${body.id}`)).status, 200);
      assert.ok(!(await admin.get('/api/invites')).body.some((i) => i.id === body.id));
      const anon = server.anon({ ip: '127.0.0.22' });
      assert.equal((await anon.get(`/api/signup/${token}`)).status, 404);
      assert.equal((await anon.post(`/api/signup/${token}`, { display_name: 'C', password: 'cancelled-pass-1' })).status, 404);
      // cancelling again, or something that never existed
      assert.equal((await admin.del(`/api/invites/${body.id}`)).status, 404);
      assert.equal((await admin.del('/api/invites/999999')).status, 404);
    });

    it('refuses duplicates, existing accounts and bad addresses', async () => {
      const first = await admin.post('/api/invites', { email: 'dupe@example.com' });
      assert.equal(first.status, 201);
      const again = await admin.post('/api/invites', { email: 'DUPE@example.com' });
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'pending_invite');
      assert.equal(again.body.invite_id, first.body.id);

      const existing = await admin.post('/api/invites', { email: 'plain@example.com' });
      assert.equal(existing.status, 409);
      assert.equal(existing.body.code, 'has_account');

      assert.equal((await admin.post('/api/invites', { email: 'not-an-email' })).status, 400);
      assert.equal((await admin.post('/api/invites', {})).status, 400);
    });

    it('unknown and expired invite links are refused', async () => {
      const anon = server.anon({ ip: '127.0.0.23' });
      assert.equal((await anon.get(`/api/signup/${BAD_TOKEN}`)).status, 404);
      assert.equal((await anon.get('/api/signup/not-a-token')).status, 404);

      const { body } = await admin.post('/api/invites', { email: 'late@example.com' });
      expireLink(server, body.link);
      const token = tokenFromLink(body.link);
      assert.equal((await anon.get(`/api/signup/${token}`)).status, 410);
      assert.equal((await anon.post(`/api/signup/${token}`, { display_name: 'L', password: 'late-pass-123' })).status, 410);
      // expired invites aren't listed as pending
      assert.ok(!(await admin.get('/api/invites')).body.some((i) => i.id === body.id));
      assert.equal((await anon.get('/api/me')).status, 401);
    });

    it('a reset link is not an invite (kinds are separate)', async () => {
      const { body } = await admin.post('/api/invites', { email: 'kind@example.com' });
      const anon = server.anon({ ip: '127.0.0.24' });
      assert.equal((await anon.get(`/api/reset/${tokenFromLink(body.link)}`)).status, 404);
      assert.equal((await anon.get(`/api/confirm-email/${tokenFromLink(body.link)}`)).status, 404);
    });
  });
});
