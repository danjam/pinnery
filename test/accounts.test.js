import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { startServer } from './helpers/server.js';
import { linkFrom, tokenFromLink } from './helpers/mail.js';

const BAD_TOKEN = 'f'.repeat(64);

// Make every emailed link of a kind already expired (the server only reads the row).
function expireLinks(server, kind) {
  const db = new Database(path.join(server.dataDir, 'pinnery.db'));
  try {
    db.pragma('busy_timeout = 5000');
    db.prepare('UPDATE email_tokens SET expires_at = ? WHERE kind = ?').run('2000-01-01T00:00:00.000Z', kind);
  } finally {
    db.close();
  }
}

const userByEmail = async (admin, email) => (await admin.get('/api/users')).body.find((u) => u.email === email);

describe('accounts (mail on)', () => {
  let server, admin;
  before(async () => {
    server = await startServer({ mail: true });
    admin = await server.adminClient();
  });
  after(() => server.stop());

  it('reports mail enabled', async () => {
    assert.deepEqual((await server.anon().get('/api/mail')).body, { enabled: true });
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
      expireLinks(server, 'invite');
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
      expireLinks(server, 'reset');
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

  describe('email change', () => {
    let carol;
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
  });

  describe('admin user management', () => {
    let frank, frankToken;
    before(async () => {
      frank = await server.createUser('frank@example.com', 'frank-pass-1');
      frankToken = await frank.mintToken('f');
    });

    it('lists users with counts, admin only', async () => {
      const list = await admin.get('/api/users');
      assert.equal(list.status, 200);
      const f = list.body.find((u) => u.email === 'frank@example.com');
      assert.equal(f.is_admin, false);
      assert.equal(typeof f.boards, 'number');
      assert.equal(typeof f.pins, 'number');
      assert.ok(list.body.find((u) => u.email === 'admin@example.com').is_admin);
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

describe('accounts (mail off)', () => {
  let server, admin;
  before(async () => {
    server = await startServer();
    admin = await server.adminClient();
  });
  after(() => server.stop());

  it('reports mail disabled', async () => {
    assert.deepEqual((await server.anon().get('/api/mail')).body, { enabled: false });
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
