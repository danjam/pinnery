import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './helpers/server.js';
import { linkFrom, tokenFromLink } from './helpers/mail.js';
import { jpegBuffer, pngBuffer } from './helpers/images.js';

describe('harness (mail off)', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());

  test('server is healthy', async () => {
    const { status, body } = await server.anon().get('/healthz');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  test('unauthenticated requests are refused', async () => {
    assert.equal((await server.anon().get('/api/me')).status, 401);
  });

  test('admin must change the password before anything else', async () => {
    const c = await server.login('admin@example.com', 'initial-pass-1');
    const gated = await c.get('/api/me');
    assert.equal(gated.status, 403);
    assert.equal(gated.body.code, 'password_change_required');
  });

  test('adminClient completes the forced change and sees /api/me', async () => {
    const admin = await server.adminClient();
    const { status, body } = await admin.get('/api/me');
    assert.equal(status, 200);
    assert.equal(body.email, 'admin@example.com');
    assert.equal(body.is_admin, true);
    assert.equal(body.must_change_password, false);
    assert.equal(await server.adminClient(), admin);
  });

  test('createUser makes a normal, signed-in user', async () => {
    const bob = await server.createUser('bob@example.com', 'bob-password-1');
    const { status, body } = await bob.get('/api/me');
    assert.equal(status, 200);
    assert.equal(body.email, 'bob@example.com');
    assert.equal(body.is_admin, false);
    assert.equal((await bob.get('/api/invites')).status, 403);
    // and can sign in again with the password it chose
    assert.equal((await (await server.login('bob@example.com', 'bob-password-1')).get('/api/me')).status, 200);
  });

  test('bearer tokens work', async () => {
    const token = await (await server.adminClient()).mintToken('smoke');
    assert.match(token, /^pn_/);
    assert.equal((await server.bearer(token).get('/api/me')).body.email, 'admin@example.com');
  });

  test('mail is off', async () => {
    assert.deepEqual((await server.anon().get('/api/mail')).body, { enabled: false });
  });

  test('image helpers produce real images', async () => {
    const png = await pngBuffer({ width: 10, height: 20, color: '#00ff00' });
    assert.deepEqual([...png.subarray(1, 4)], [...Buffer.from('PNG')]);
    const jpg = await jpegBuffer();
    assert.deepEqual([...jpg.subarray(0, 2)], [0xff, 0xd8]);
  });
});

describe('harness (mail on)', () => {
  let server;
  before(async () => { server = await startServer({ mail: true }); });
  after(() => server.stop());

  test('invite email lands in the sink and its link works', async () => {
    const admin = await server.adminClient();
    const { status, body } = await admin.post('/api/invites', { email: 'carol@example.com' });
    assert.equal(status, 201);
    assert.equal(body.sent, true);
    const mail = await server.mail.waitFor((m) => m.to.includes('carol@example.com'));
    const link = linkFrom(mail, '/signup/');
    assert.equal(link, body.link);
    const info = await server.anon().get(`/api/signup/${tokenFromLink(link)}`);
    assert.deepEqual(info.body, { email: 'carol@example.com' });
  });

  test('forgot-password email carries a working reset link', async () => {
    await server.createUser('dave@example.com', 'dave-password-1');
    const { body } = await server.anon().post('/api/forgot', { email: 'dave@example.com' });
    assert.equal(body.mail, true);
    const mail = await server.mail.waitFor((m) => m.subject.includes('Reset'));
    assert.deepEqual(mail.to, ['dave@example.com']);
    const info = await server.anon().get(`/api/reset/${tokenFromLink(linkFrom(mail, '/reset/'))}`);
    assert.deepEqual(info.body, { email: 'dave@example.com' });
  });
});

test('stop() removes the data dir and the process', async () => {
  const server = await startServer({ mail: true });
  const { dataDir } = server;
  assert.ok(fs.existsSync(dataDir));
  await server.stop();
  assert.ok(!fs.existsSync(dataDir));
  await assert.rejects(fetch(`${server.url}/healthz`));
});
