import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

describe('/api/me and admin-only routes', () => {
  let server, erin, admin;
  before(async () => {
    server = await startServer();
    admin = await server.adminClient();
    erin = await server.createUser('erin@example.com', 'erin-password-1', { displayName: 'Erin' });
  });
  after(() => server.stop());

  it('GET /api/me describes the caller without leaking the hash', async () => {
    const { status, body } = await erin.get('/api/me');
    assert.equal(status, 200);
    assert.equal(body.email, 'erin@example.com');
    assert.equal(body.display_name, 'Erin');
    assert.equal(body.is_admin, false);
    assert.equal(body.must_change_password, false);
    assert.ok(!('password_hash' in body));
    assert.equal((await admin.get('/api/me')).body.is_admin, true);
  });

  it('PATCH /api/me renames, trims, and validates', async () => {
    const r = await erin.patch('/api/me', { display_name: '  Erin J  ' });
    assert.equal(r.status, 200);
    assert.equal(r.body.display_name, 'Erin J');
    assert.equal((await erin.get('/api/me')).body.display_name, 'Erin J');
    assert.equal((await erin.patch('/api/me', { display_name: '   ' })).status, 400);
    assert.equal((await erin.patch('/api/me', { display_name: 'x'.repeat(101) })).status, 400);
    assert.equal((await erin.patch('/api/me', { display_name: 42 })).status, 400);
    assert.equal((await erin.get('/api/me')).body.display_name, 'Erin J');
    assert.equal((await server.anon().patch('/api/me', { display_name: 'x' })).status, 401);
  });

  it('refuses admin routes for a normal user and allows them for the admin', async () => {
    assert.equal((await erin.get('/api/invites')).status, 403);
    assert.equal((await erin.post('/api/invites', { email: 'x@example.com' })).status, 403);
    assert.equal((await erin.del('/api/invites/1')).status, 403);
    assert.equal((await erin.get('/api/users')).status, 403);
    assert.equal((await server.anon().get('/api/invites')).status, 401);
    assert.equal((await server.anon().get('/api/users')).status, 401);
    assert.equal((await admin.get('/api/invites')).status, 200);
    assert.equal((await admin.get('/api/users')).status, 200);
  });

  it('a bearer token carries the user\'s admin-ness, no more', async () => {
    const t = await erin.mintToken('e');
    assert.equal((await server.bearer(t).get('/api/invites')).status, 403);
    const at = await admin.mintToken('a');
    assert.equal((await server.bearer(at).get('/api/invites')).status, 200);
  });
});
