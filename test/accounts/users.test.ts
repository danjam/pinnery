import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.ts';
import type { Client, MailServer } from '../helpers/server.ts';
import { linkFrom, tokenFromLink } from '../helpers/mail.ts';
import { userByEmail } from '../helpers/accounts.ts';

describe('accounts (mail on)', () => {
  let server: MailServer, admin: Client;
  before(async () => {
    server = await startServer({ mail: true });
    admin = await server.adminClient();
  });
  after(() => server.stop());

  describe('admin user management', () => {
    let frank: Client, frankToken: string;
    before(async () => {
      frank = await server.createUser('frank@example.com', 'frank-pass-1');
      frankToken = await frank.mintToken('f');
    });

    it('lists users with counts, admin only', async () => {
      const list = await admin.get('/api/users');
      assert.equal(list.status, 200);
      const f = list.body.find((u: { email: string }) => u.email === 'frank@example.com');
      assert.equal(f.is_admin, false);
      assert.equal(typeof f.boards, 'number');
      assert.equal(typeof f.pins, 'number');
      assert.ok(list.body.find((u: { email: string }) => u.email === 'admin@example.com').is_admin);
      assert.equal((await frank.get('/api/users')).status, 403);
      assert.equal((await server.anon().get('/api/users')).status, 401);
    });

    it('promotes and demotes; demoting ends sessions and tokens', async () => {
      const f = await userByEmail(admin, 'frank@example.com');
      const up = await admin.patch(`/api/users/${f.id}`, { is_admin: true });
      assert.equal(up.status, 200);
      assert.equal(up.body.is_admin, true);
      assert.equal((await frank.get('/api/invites')).status, 200);

      const down = await admin.patch(`/api/users/${f.id}`, { is_admin: false });
      assert.equal(down.status, 200);
      assert.equal(down.body.is_admin, false);
      assert.equal((await frank.get('/api/me')).status, 401);
      assert.equal((await server.bearer(frankToken).get('/api/me')).status, 401);
      // account itself survives
      await server.login('frank@example.com', 'frank-pass-1', { ip: '127.0.0.50' });
    });

    it('validates the PATCH body and target', async () => {
      const f = await userByEmail(admin, 'frank@example.com');
      assert.equal((await admin.patch(`/api/users/${f.id}`, { is_admin: 'yes' })).status, 400);
      assert.equal((await admin.patch(`/api/users/${f.id}`, {})).status, 400);
      assert.equal((await admin.patch('/api/users/999999', { is_admin: true })).status, 404);
      assert.equal((await admin.patch('/api/users/abc', { is_admin: true })).status, 404);
    });

    it('protects the last admin and self-deletion', async () => {
      const me = await userByEmail(admin, 'admin@example.com');
      const demote = await admin.patch(`/api/users/${me.id}`, { is_admin: false });
      assert.equal(demote.status, 409);
      const del = await admin.del(`/api/users/${me.id}`);
      assert.equal(del.status, 409);
      assert.equal((await admin.get('/api/me')).body.is_admin, true);
    });

    it('with two admins either may be demoted, but nobody deletes themselves', async () => {
      const g = await server.createUser('gina@example.com', 'gina-pass-123');
      const gu = await userByEmail(admin, 'gina@example.com');
      await admin.patch(`/api/users/${gu.id}`, { is_admin: true });
      assert.equal((await g.del(`/api/users/${gu.id}`)).status, 409);
      assert.equal((await admin.patch(`/api/users/${gu.id}`, { is_admin: false })).status, 200);
      assert.equal((await g.get('/api/me')).status, 401);
    });

    it('deleting a user ends their sessions and tokens and frees the email', async () => {
      const h = await server.createUser('hank@example.com', 'hank-pass-123');
      const tok = await h.mintToken('h');
      const a2 = admin;
      const hu = await userByEmail(a2, 'hank@example.com');
      assert.equal((await a2.del(`/api/users/${hu.id}`)).status, 200);
      assert.equal((await h.get('/api/me')).status, 401);
      assert.equal((await server.bearer(tok).get('/api/me')).status, 401);
      assert.equal((await server.anon({ ip: '127.0.0.52' }).post('/api/login', { email: 'hank@example.com', password: 'hank-pass-123' })).status, 401);
      assert.ok(!(await userByEmail(a2, 'hank@example.com')));
      assert.equal((await a2.del(`/api/users/${hu.id}`)).status, 404);
      // the address can be invited again
      assert.equal((await a2.post('/api/invites', { email: 'hank@example.com' })).status, 201);
    });

    it('deleting an inviter does not break accounts they invited', async () => {
      const a2 = admin;
      const inviterU = await server.createUser('inviter@example.com', 'inviter-pass-1');
      const iu = await userByEmail(a2, 'inviter@example.com');
      await a2.patch(`/api/users/${iu.id}`, { is_admin: true });
      const inv = await (await server.login('inviter@example.com', 'inviter-pass-1', { ip: '127.0.0.54' })).post('/api/invites', { email: 'orphan@example.com' });
      assert.equal(inv.status, 201);
      await a2.del(`/api/users/${iu.id}`);
      assert.equal((await inviterU.get('/api/me')).status, 401);
      // invites sent by a deleted user cascade away
      assert.equal((await server.anon({ ip: '127.0.0.55' }).get(`/api/signup/${tokenFromLink(inv.body.link)}`)).status, 404);
    });

    it('admin-issued reset link is emailed and returned, and works', async () => {
      const a2 = admin;
      const target = await server.createUser('ivy@example.com', 'ivy-pass-123');
      const iu = await userByEmail(a2, 'ivy@example.com');
      server.mail.clear();
      const res = await a2.post(`/api/users/${iu.id}/reset`);
      assert.equal(res.status, 201);
      assert.equal(res.body.email, 'ivy@example.com');
      assert.equal(res.body.sent, true);
      const mail = await server.mail.waitFor((m) => m.to.includes('ivy@example.com') && /reset/i.test(m.subject));
      assert.equal(linkFrom(mail, '/reset/'), res.body.link);
      const anon = server.anon({ ip: '127.0.0.57' });
      assert.equal((await anon.post(`/api/reset/${tokenFromLink(res.body.link)}`, { password: 'ivy-new-pass-1' })).status, 200);
      assert.equal((await target.get('/api/me')).status, 401);
      const kim = await server.createUser('kim@example.com', 'kim-pass-12345');
      assert.equal((await kim.post(`/api/users/${iu.id}/reset`)).status, 403);
      assert.equal((await server.anon().post(`/api/users/${iu.id}/reset`)).status, 401);
      assert.equal((await a2.post('/api/users/999999/reset')).status, 404);
    });
  });
});
