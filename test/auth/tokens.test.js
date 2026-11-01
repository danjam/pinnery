import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';

describe('API tokens', () => {
  let server, carol, dave;
  before(async () => {
    server = await startServer({ mail: true });
    carol = await server.createUser('carol@example.com', 'carol-password-1');
    dave = await server.createUser('dave@example.com', 'dave-password-1');
  });
  after(() => server.stop());

  it('issues a named pn_ token, lists it without the secret, and it authenticates', async () => {
    const { status, body } = await carol.post('/api/tokens', { email: 'carol@example.com', password: 'carol-password-1', name: '  laptop  ' });
    assert.equal(status, 201);
    assert.match(body.token, /^pn_[0-9a-f]{64}$/);
    assert.equal(body.name, 'laptop');
    const list = await carol.get('/api/tokens');
    assert.equal(list.status, 200);
    const row = list.body.find((t) => t.id === body.id);
    assert.equal(row.name, 'laptop');
    assert.ok(!JSON.stringify(list.body).includes(body.token));
    assert.equal(row.current, false);
    const viaToken = await server.bearer(body.token).get('/api/me');
    assert.equal(viaToken.body.email, 'carol@example.com');
    // the token's own listing marks it as current
    const own = await server.bearer(body.token).get('/api/tokens');
    assert.equal(own.body.find((t) => t.id === body.id).current, true);
    assert.ok((await carol.get('/api/tokens')).body.find((t) => t.id === body.id).last_used_at);
  });

  it('requires a name and valid credentials', async () => {
    const c = server.anon({ ip: '127.0.0.50' });
    assert.equal((await c.post('/api/tokens', { email: 'carol@example.com', password: 'carol-password-1', name: '   ' })).status, 400);
    assert.equal((await c.post('/api/tokens', { email: 'carol@example.com', password: 'carol-password-1' })).status, 400);
    assert.equal((await c.post('/api/tokens', { email: 'carol@example.com', password: 'wrong', name: 'x' })).status, 401);
  });

  it('revoking one token kills only that token', async () => {
    const t1 = await carol.mintToken('one');
    const t2 = await carol.mintToken('two');
    const list = (await carol.get('/api/tokens')).body;
    const id1 = list.find((t) => t.name === 'one').id;
    const r = await carol.del(`/api/tokens/${id1}`);
    assert.equal(r.status, 200);
    assert.equal((await server.bearer(t1).get('/api/me')).status, 401);
    assert.equal((await server.bearer(t2).get('/api/me')).status, 200);
    assert.equal((await carol.del(`/api/tokens/${id1}`)).status, 404);
    assert.equal((await carol.del('/api/tokens/abc')).status, 404);
  });

  it("cannot revoke another user's token, and sessions are not listed as tokens", async () => {
    const t = await dave.mintToken('dave-only');
    const id = (await dave.get('/api/tokens')).body.find((x) => x.name === 'dave-only').id;
    assert.equal((await carol.del(`/api/tokens/${id}`)).status, 404);
    assert.equal((await server.bearer(t).get('/api/me')).status, 200);
    assert.ok(!(await carol.get('/api/tokens')).body.some((x) => x.id === id));
    // a browser session row is not revocable through the tokens route
    const { body: me } = await dave.get('/api/tokens');
    assert.ok(me.every((x) => x.name));
  });

  it('revoke all removes every token of the caller, not other users\' or the session', async () => {
    const a = await carol.mintToken('a');
    const b = await carol.mintToken('b');
    const d = await dave.mintToken('d2');
    const r = await carol.del('/api/tokens');
    assert.equal(r.status, 200);
    assert.ok(r.body.revoked >= 2);
    assert.equal((await server.bearer(a).get('/api/me')).status, 401);
    assert.equal((await server.bearer(b).get('/api/me')).status, 401);
    assert.deepEqual((await carol.get('/api/tokens')).body, []);
    assert.equal((await carol.get('/api/me')).status, 200);
    assert.equal((await server.bearer(d).get('/api/me')).status, 200);
  });

  it('a bearer token cannot change the password or email, nor mint more tokens without credentials', async () => {
    const t = await carol.mintToken('limited');
    const bearer = server.bearer(t);
    assert.equal((await bearer.post('/api/password', { current: 'carol-password-1', new: 'carol-password-2' })).status, 401);
    const email = await bearer.post('/api/email', { email: 'new@example.com', password: 'carol-password-1' });
    assert.equal(email.status, 403);
    assert.equal((await server.anon().post('/api/tokens', {})).status, 401);
    // nothing changed
    assert.equal((await server.login('carol@example.com', 'carol-password-1', { ip: '127.0.0.51' })).cookie() !== null, true);
  });

  it('bogus and malformed bearer values are 401', async () => {
    assert.equal((await server.bearer('pn_' + '0'.repeat(64)).get('/api/me')).status, 401);
    assert.equal((await server.anon().get('/api/me', { headers: { authorization: 'Bearer ' } })).status, 401);
    assert.equal((await server.anon().get('/api/tokens')).status, 401);
    assert.equal((await server.anon().del('/api/tokens')).status, 401);
  });
});
