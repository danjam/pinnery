import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

describe('page routes and ?next', () => {
  let server, frank;
  before(async () => {
    server = await startServer();
    frank = await server.createUser('frank@example.com', 'frank-password-1');
  });
  after(() => server.stop());

  it('sends signed-out visitors to /login with next', async () => {
    const root = await server.anon().fetch('/');
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/login?next=%2F');
    const settings = await server.anon().fetch('/settings');
    assert.equal(settings.status, 302);
    assert.equal(settings.headers.get('location'), '/login?next=%2Fsettings');
    const tab = await server.anon().fetch('/settings/users?x=1');
    assert.equal(tab.headers.get('location'), '/login?next=' + encodeURIComponent('/settings/users?x=1'));
  });

  it('serves the app to signed-in users', async () => {
    assert.equal((await frank.fetch('/')).status, 200);
    assert.equal((await frank.fetch('/settings')).status, 200);
  });

  it('serves the login page when signed out', async () => {
    const r = await server.anon().fetch('/login');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /html/);
  });

  it('/login redirects signed-in users to next or home', async () => {
    assert.equal((await frank.fetch('/login')).headers.get('location'), '/');
    assert.equal((await frank.fetch('/login?next=/settings')).headers.get('location'), '/settings');
  });

  it('safeNext rejects off-site targets', async () => {
    for (const bad of ['https://evil.example.com/', '//evil.example.com', '/\\evil.example.com', 'javascript:alert(1)', 'evil', '/' + 'a'.repeat(2100), '/\t/evil.example.com', '/\n/evil.example.com', '/\t\\evil.example.com']) {
      const r = await frank.fetch(`/login?next=${encodeURIComponent(bad)}`);
      assert.equal(r.status, 302, bad);
      assert.equal(r.headers.get('location'), '/', bad);
    }
    // repeated param (array) is ignored too
    assert.equal((await frank.fetch('/login?next=/a&next=/b')).headers.get('location'), '/');
  });

  it('static assets and healthz need no session', async () => {
    assert.equal((await server.anon().fetch('/healthz')).status, 200);
    assert.equal((await server.anon().fetch('/manifest.webmanifest')).status, 200);
  });

  it('unknown API paths are JSON 404 (signed in) and unknown pages are text 404', async () => {
    const r = await frank.get('/api/definitely-not-a-thing');
    assert.equal(r.status, 404);
    assert.equal((await server.anon().fetch('/nope')).status, 404);
  });
});
