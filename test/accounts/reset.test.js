import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { linkFrom, tokenFromLink } from '../helpers/mail.js';
import { BAD_TOKEN, expireLink, userByEmail } from '../helpers/accounts.js';

describe('accounts (mail on)', () => {
  let server, admin;
  before(async () => {
    server = await startServer({ mail: true });
    admin = await server.adminClient();
  });
  after(() => server.stop());

  describe('forgot and reset password', () => {
    let alice, aliceOther;
    before(async () => {
      alice = await server.createUser('alice@example.com', 'alice-pass-1');
      aliceOther = await server.login('alice@example.com', 'alice-pass-1', { ip: '127.0.0.30' });
    });

    it('emails a reset link that changes the password and signs other sessions out', async () => {
      server.mail.clear();
      const anon = server.anon({ ip: '127.0.0.31' });
      const forgot = await anon.post('/api/forgot', { email: 'Alice@Example.com' });
      assert.deepEqual(forgot.body, { ok: true, mail: true });
      const mail = await server.mail.waitFor((m) => m.to.includes('alice@example.com') && /reset/i.test(m.subject));
      const token = tokenFromLink(linkFrom(mail, '/reset/'));

      assert.deepEqual((await anon.get(`/api/reset/${token}`)).body, { email: 'alice@example.com' });
      assert.equal((await anon.post(`/api/reset/${token}`, { password: 'short' })).status, 400);
      // the failed attempt didn't consume it
      const done = await anon.post(`/api/reset/${token}`, { password: 'alice-new-pass-1' });
      assert.equal(done.status, 200);
      assert.equal(done.body.ok, true);
      assert.equal(typeof done.body.tokens, 'number');

      // resetting signs the resetter in
      assert.equal((await anon.get('/api/me')).body.email, 'alice@example.com');
      // other browsers are signed out, including the one that was open before
      assert.equal((await alice.get('/api/me')).status, 401);
      assert.equal((await aliceOther.get('/api/me')).status, 401);
      // link is single-use
      assert.equal((await anon.get(`/api/reset/${token}`)).status, 404);

      // old password stops working, new one works
      const ip = '127.0.0.32';
      const bad = await server.anon({ ip }).post('/api/login', { email: 'alice@example.com', password: 'alice-pass-1' });
      assert.equal(bad.status, 401);
      await server.login('alice@example.com', 'alice-new-pass-1', { ip });

      // and a "your password was changed" notice goes out
      await server.mail.waitFor((m) => m.to.includes('alice@example.com') && /password was changed/i.test(m.subject));
    });

    it('answers the same for unknown addresses and sends no mail', async () => {
      server.mail.clear();
      const anon = server.anon({ ip: '127.0.0.33' });
      const known = await anon.post('/api/forgot', { email: 'alice@example.com' });
      const unknown = await anon.post('/api/forgot', { email: 'nobody@example.com' });
      assert.equal(unknown.status, known.status);
      assert.deepEqual(unknown.body, known.body);
      await server.mail.waitFor((m) => m.to.includes('alice@example.com'));
      // can only pass falsely, never fail falsely: it only checks that no (extra) mail arrived
      // give a stray mail the chance to show up
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!server.mail.messages.some((m) => m.to.includes('nobody@example.com')));
      assert.equal(server.mail.messages.filter((m) => /reset/i.test(m.subject)).length, 1);
    });

    it('rejects a malformed address and caps requests per address', async () => {
      const anon = server.anon({ ip: '127.0.0.34' });
      assert.equal((await anon.post('/api/forgot', { email: 'nope' })).status, 400);
      server.mail.clear();
      for (let i = 0; i < 4; i++) {
        const r = await anon.post('/api/forgot', { email: 'capped@example.com' });
        assert.equal(r.status, 200);
      }
      // capped@ has no account; use a real one for the mail count
      server.mail.clear();
      const bob = await server.createUser('bobcap@example.com', 'bobcap-pass-1');
      assert.ok(bob);
      const anon2 = server.anon({ ip: '127.0.0.35' });
      for (let i = 0; i < 4; i++) assert.equal((await anon2.post('/api/forgot', { email: 'bobcap@example.com' })).status, 200);
      const resetsTo = () => server.mail.messages.filter((m) => m.to.includes('bobcap@example.com') && /reset/i.test(m.subject));
      // wait for all three (sent in the background), then give a fourth the chance to show up
      await server.mail.waitFor(() => resetsTo().length >= 3);
      // can only pass falsely, never fail falsely: it only checks that no (extra) mail arrived
      await new Promise((r) => setTimeout(r, 400));
      const sent = resetsTo();
      assert.equal(sent.length, 3); // 4th silently dropped
    });

    it('expired and unknown reset links are refused', async () => {
      const anon = server.anon({ ip: '127.0.0.36' });
      assert.equal((await anon.get(`/api/reset/${BAD_TOKEN}`)).status, 404);
      const u = await admin.get('/api/users');
      const target = u.body.find((x) => x.email === 'alice@example.com');
      const { body } = await admin.post(`/api/users/${target.id}/reset`);
      expireLink(server, body.link);
      assert.equal((await anon.get(`/api/reset/${tokenFromLink(body.link)}`)).status, 410);
      assert.equal((await anon.post(`/api/reset/${tokenFromLink(body.link)}`, { password: 'whatever-pass-1' })).status, 410);
    });

    it('a newer reset link cancels the older one', async () => {
      const target = await userByEmail(admin, 'alice@example.com');
      const one = await admin.post(`/api/users/${target.id}/reset`);
      const two = await admin.post(`/api/users/${target.id}/reset`);
      const anon = server.anon({ ip: '127.0.0.37' });
      assert.equal((await anon.get(`/api/reset/${tokenFromLink(one.body.link)}`)).status, 404);
      assert.equal((await anon.get(`/api/reset/${tokenFromLink(two.body.link)}`)).status, 200);
    });
  });
});
