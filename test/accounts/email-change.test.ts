import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.ts';
import type { Client, MailServer } from '../helpers/server.ts';
import { linkFrom, tokenFromLink } from '../helpers/mail.ts';

describe('accounts (mail on)', () => {
  let server: MailServer, admin: Client;
  before(async () => {
    server = await startServer({ mail: true });
    admin = await server.adminClient();
    // taken-address check below expects an existing account
    await server.createUser('plain@example.com', 'plain-pass-1');
  });
  after(() => server.stop());

  describe('email change', () => {
    let carol: Client;
    before(async () => { carol = await server.createUser('carol@example.com', 'carol-pass-1'); });

    it('needs a cookie session and the right password', async () => {
      const ip = '127.0.0.40';
      const c = await server.login('carol@example.com', 'carol-pass-1', { ip });
      const wrong = await c.post('/api/email', { email: 'carol2@example.com', password: 'nope-nope-1' });
      assert.equal(wrong.status, 403);
      const token = await carol.mintToken('t');
      const viaToken = await server.bearer(token, { ip }).post('/api/email', { email: 'carol2@example.com', password: 'carol-pass-1' });
      assert.equal(viaToken.status, 403);
      assert.equal((await server.anon({ ip }).post('/api/email', { email: 'x@example.com', password: 'x' })).status, 401);
      assert.equal((await carol.get('/api/me')).body.email, 'carol@example.com');
    });

    it('validates the new address', async () => {
      assert.equal((await carol.post('/api/email', { email: 'bad', password: 'carol-pass-1' })).status, 400);
      assert.equal((await carol.post('/api/email', { email: 'carol@example.com', password: 'carol-pass-1' })).status, 400);
      const taken = await carol.post('/api/email', { email: 'plain@example.com', password: 'carol-pass-1' });
      assert.equal(taken.status, 409);
    });

    it('changes nothing until the emailed link is confirmed', async () => {
      server.mail.clear();
      const res = await carol.post('/api/email', { email: 'Carol.New@Example.com', password: 'carol-pass-1' });
      assert.equal(res.status, 200);
      assert.equal(res.body.email, 'carol.new@example.com');
      const mail = await server.mail.waitFor((m) => m.to.includes('carol.new@example.com'));
      const token = tokenFromLink(linkFrom(mail, '/confirm-email/'));

      assert.equal((await carol.get('/api/me')).body.email, 'carol@example.com');
      const anon = server.anon({ ip: '127.0.0.41' });
      assert.deepEqual((await anon.get(`/api/confirm-email/${token}`)).body, { email: 'carol.new@example.com' });
      // GET alone doesn't change it
      assert.equal((await carol.get('/api/me')).body.email, 'carol@example.com');

      const done = await anon.post(`/api/confirm-email/${token}`);
      assert.equal(done.status, 200);
      assert.equal((await carol.get('/api/me')).body.email, 'carol.new@example.com');
      assert.equal((await anon.get(`/api/confirm-email/${token}`)).status, 404);

      // sign-in now uses the new address only
      const ip = '127.0.0.42';
      assert.equal((await server.anon({ ip }).post('/api/login', { email: 'carol@example.com', password: 'carol-pass-1' })).status, 401);
      await server.login('carol.new@example.com', 'carol-pass-1', { ip });
    });

    it('a second request replaces the first link', async () => {
      const dan = await server.createUser('dan@example.com', 'dan-pass-123');
      server.mail.clear();
      await dan.post('/api/email', { email: 'dan.one@example.com', password: 'dan-pass-123' });
      const m1 = await server.mail.waitFor((m) => m.to.includes('dan.one@example.com'));
      await dan.post('/api/email', { email: 'dan.two@example.com', password: 'dan-pass-123' });
      const m2 = await server.mail.waitFor((m) => m.to.includes('dan.two@example.com'));
      const anon = server.anon({ ip: '127.0.0.43' });
      assert.equal((await anon.post(`/api/confirm-email/${tokenFromLink(linkFrom(m1, '/confirm-email/'))}`)).status, 404);
      assert.equal((await anon.post(`/api/confirm-email/${tokenFromLink(linkFrom(m2, '/confirm-email/'))}`)).status, 200);
      assert.equal((await dan.get('/api/me')).body.email, 'dan.two@example.com');
    });

    it('refuses confirmation if the address was taken meanwhile', async () => {
      const erin = await server.createUser('erin@example.com', 'erin-pass-123');
      server.mail.clear();
      await erin.post('/api/email', { email: 'race@example.com', password: 'erin-pass-123' });
      const mail = await server.mail.waitFor((m) => m.to.includes('race@example.com'));
      await server.createUser('race@example.com', 'race-pass-123');
      const res = await server.anon({ ip: '127.0.0.44' }).post(`/api/confirm-email/${tokenFromLink(linkFrom(mail, '/confirm-email/'))}`);
      assert.equal(res.status, 409);
      assert.equal((await erin.get('/api/me')).body.email, 'erin@example.com');
    });

    it('tells the old address and cancels its reset links', async () => {
      const fay = await server.createUser('fay@example.com', 'fay-pass-1234');
      const { id } = (await fay.get('/api/me')).body;
      const reset = await admin.post(`/api/users/${id}/reset`);
      assert.equal(reset.status, 201);
      server.mail.clear();
      await fay.post('/api/email', { email: 'fay.new@example.com', password: 'fay-pass-1234' });
      const mail = await server.mail.waitFor((m) => m.to.includes('fay.new@example.com'));
      const anon = server.anon({ ip: '127.0.0.45' });
      assert.equal((await anon.post(`/api/confirm-email/${tokenFromLink(linkFrom(mail, '/confirm-email/'))}`)).status, 200);

      const notice = await server.mail.waitFor((m) => m.to.includes('fay@example.com'));
      assert.equal(notice.subject, 'Your Pinnery email was changed');
      assert.match(notice.text, /fay\.new@example\.com/);
      assert.equal((await anon.get(`/api/reset/${tokenFromLink(reset.body.link)}`)).status, 404);
    });
  });
});
