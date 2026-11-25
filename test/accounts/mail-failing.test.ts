import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer } from '../helpers/server.ts';
import type { Client, Server } from '../helpers/server.ts';
import { tokenFromLink } from '../helpers/mail.ts';
import { userByEmail } from '../helpers/accounts.ts';

// Mail is set up but the SMTP server refuses connections: every send fails. Links still work.
const closedPort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as net.AddressInfo;
    s.close(() => resolve(port));
  });
});

describe('accounts (mail failing)', () => {
  let server: Server, admin: Client;
  before(async () => {
    server = await startServer({ env: {
      PINNERY_SMTP_HOST: '127.0.0.1',
      PINNERY_SMTP_PORT: String(await closedPort()),
      PINNERY_SMTP_SECURE: 'false',
      PINNERY_SMTP_FROM: 'Pinnery <pinnery@example.com>',
    } });
    admin = await server.adminClient();
  });
  after(() => server.stop());

  it('invites still return the link, with the send error', async () => {
    const { status, body } = await admin.post('/api/invites', { email: 'fail@example.com' });
    assert.equal(status, 201);
    assert.equal(body.sent, false);
    assert.match(body.error, /^couldn't send the email: /);
    assert.match(body.link, /\/signup\/[0-9a-f]{64}$/);
    assert.deepEqual((await server.anon().get(`/api/signup/${tokenFromLink(body.link)}`)).body, { email: 'fail@example.com' });
  });

  it('admin reset still returns the link, with the send error', async () => {
    await server.createUser('kim@example.com', 'kim-pass-12345');
    const kim = await userByEmail(admin, 'kim@example.com');
    const { status, body } = await admin.post(`/api/users/${kim.id}/reset`);
    assert.equal(status, 201);
    assert.equal(body.sent, false);
    assert.match(body.error, /^couldn't send the email: /);
    assert.match(body.link, /\/reset\/[0-9a-f]{64}$/);
  });

  it('email change fails with 502 and leaves the address alone', async () => {
    const lee = await server.createUser('lee@example.com', 'lee-pass-12345');
    const res = await lee.post('/api/email', { email: 'lee2@example.com', password: 'lee-pass-12345' });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /^couldn't send the email: .*The address hasn’t changed\.$/);
    assert.equal((await lee.get('/api/me')).body.email, 'lee@example.com');
  });
});
