import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.ts';
import type { Client, Server } from '../helpers/server.ts';

// Cookie-authenticated writes, sign-in and sign-out only from our own pages (server.ts). The test
// client sends `sec-fetch-site: same-origin` by default; '' sends neither header.
describe('cross-site writes', () => {
  let server: Server, alice: Client;
  before(async () => {
    server = await startServer();
    alice = await server.createUser('alice@example.com', 'alice-password-1');
  });
  after(() => server.stop());

  const createBoard = (c: Client, headers: Record<string, string>, name = 'b') =>
    c.json('/api/boards', { method: 'POST', json: { name }, headers });

  it('refuses a cookie write from a sibling subdomain or another site', async () => {
    for (const site of ['same-site', 'cross-site']) {
      const { status, body } = await createBoard(alice, { 'sec-fetch-site': site });
      assert.equal(status, 403, site);
      assert.equal(body.error, 'cross-site request refused');
    }
  });

  it('refuses a cookie write with no Sec-Fetch-Site and a foreign or missing Origin', async () => {
    assert.equal((await createBoard(alice, { 'sec-fetch-site': '', origin: 'https://other.example.com' })).status, 403);
    assert.equal((await createBoard(alice, { 'sec-fetch-site': '' })).status, 403);
  });

  it('allows a cookie write from our own pages', async () => {
    assert.equal((await createBoard(alice, { 'sec-fetch-site': 'same-origin' })).status, 201);
    assert.equal((await createBoard(alice, { 'sec-fetch-site': '', origin: server.url })).status, 201);
  });

  it('refuses form uploads from another site (no preflight needed for those)', async () => {
    const form = new FormData();
    form.append('image', new Blob(['x'], { type: 'image/png' }), 'x.png');
    const res = await alice.fetch('/api/pins/upload', { method: 'POST', body: form, headers: { 'sec-fetch-site': 'same-site' } });
    assert.equal(res.status, 403);
  });

  it('exempts bearer-token requests', async () => {
    const bearer = server.bearer(await alice.mintToken());
    assert.equal((await createBoard(bearer, { 'sec-fetch-site': 'cross-site' })).status, 201);
    assert.equal((await createBoard(bearer, { 'sec-fetch-site': '' })).status, 201);
  });

  it('leaves reads alone', async () => {
    assert.equal((await alice.json('/api/me', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200);
  });

  it('refuses cross-site sign-in and sign-out', async () => {
    const anon = server.anon({ ip: '127.0.0.40' });
    const creds = { email: 'alice@example.com', password: 'alice-password-1' };
    assert.equal((await anon.json('/api/login', { method: 'POST', json: creds, headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
    const form = await anon.fetch('/api/login', {
      method: 'POST',
      body: new URLSearchParams(creds),
      headers: { 'sec-fetch-site': '', origin: 'https://other.example.com' },
    });
    assert.equal(form.status, 403);
    // Routing ignores case and a trailing slash, so the check must too.
    for (const path of ['/API/LOGIN', '/api/Login', '/api/login/']) {
      const r = await anon.fetch(path, { method: 'POST', body: new URLSearchParams(creds), headers: { 'sec-fetch-site': 'cross-site' } });
      assert.equal(r.status, 403, path);
    }
    assert.equal(anon.cookie(), null);
    assert.equal((await alice.json('/api/logout', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await alice.get('/api/me')).status, 200);
  });

  it('leaves session-less public writes alone', async () => {
    // No session cookie, no check: scripts mint tokens (and the extension trades its connect code)
    // without either header.
    const anon = server.anon({ ip: '127.0.0.41' });
    const r = await anon.json('/api/tokens', { method: 'POST', json: { email: 'alice@example.com', password: 'alice-password-1', name: 'script' }, headers: { 'sec-fetch-site': '' } });
    assert.equal(r.status, 201);
  });
});
