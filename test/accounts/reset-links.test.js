import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../helpers/server.js';
import { linkFrom } from '../helpers/mail.js';

// POST /api/forgot with a Host header of our choosing (fetch won't let us set Host).
function forgotWithHost(server, host, email) {
  const { port } = new URL(server.url);
  const body = JSON.stringify({ email });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/forgot', method: 'POST',
      headers: { Host: host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('reset links and the Host header', () => {
  describe('with PINNERY_PUBLIC_URL set', () => {
    let server;
    before(async () => {
      server = await startServer({ mail: true });
      await server.createUser('victim@example.com', 'victim-pass-1');
    });
    after(() => server.stop());

    it('builds the emailed link from PINNERY_PUBLIC_URL, not the Host header', async () => {
      server.mail.clear();
      const r = await forgotWithHost(server, 'evil.example.com', 'victim@example.com');
      assert.equal(r.status, 200);
      const msg = await server.mail.waitFor((m) => m.to.includes('victim@example.com'));
      const link = linkFrom(msg, '/reset/');
      assert.ok(link.startsWith(`${server.url}/reset/`), link);
    });
  });

  describe('with mail on but no PINNERY_PUBLIC_URL', () => {
    let server;
    before(async () => {
      server = await startServer({ mail: true, env: { PINNERY_PUBLIC_URL: '' } });
      await server.createUser('victim@example.com', 'victim-pass-1');
    });
    after(() => server.stop());

    it('says self-service reset is off', async () => {
      assert.deepEqual((await server.anon().get('/api/mail')).body, { enabled: true, reset: false });
    });

    it('sends no reset email, whatever the Host header says', async () => {
      server.mail.clear();
      const r = await forgotWithHost(server, 'evil.example.com', 'victim@example.com');
      assert.deepEqual(r, { status: 200, body: { ok: true, mail: false } });
      // can only pass falsely, never fail falsely: it only checks that no mail arrived
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(server.mail.messages.length, 0);
    });
  });
});
