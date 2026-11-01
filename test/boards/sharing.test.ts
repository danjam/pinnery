import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupBoards } from '../helpers/boards.ts';
import type { Boards } from '../helpers/boards.ts';
import type { Client, Server } from '../helpers/server.ts';

let server: Server;
let owner: Client, editor: Client, viewer: Client, other: Client, ids: Boards['ids'], board: Boards['board'], pin: Boards['pin'], sharePath: Boards['sharePath'];

describe('boards and access scoping', () => {
  before(async () => {
    ({ server, owner, editor, viewer, other, ids, board, pin, sharePath } = await setupBoards());
  });
  after(() => server.stop());

  describe('sharing', () => {
    it('only the owner lists shares; starts empty', async () => {
      assert.deepEqual((await owner.get(`/api/boards/${board.id}/shares`)).body, []);
    });

    it('rejects bad roles, unknown users and self-sharing', async () => {
      const put = (path: string, json: unknown) => owner.json(path, { method: 'PUT', json });
      assert.equal((await put(sharePath('viewer'), { role: 'owner' })).status, 400);
      assert.equal((await put(sharePath('viewer'), {})).status, 400);
      assert.equal((await put(`/api/boards/${board.id}/shares/99999`, { role: 'viewer' })).status, 404);
      assert.equal((await put(sharePath('owner'), { role: 'viewer' })).status, 400);
      assert.equal((await owner.del(sharePath('viewer'))).status, 404); // nothing to remove yet
    });

    it('adds shares and reports added / changed role', async () => {
      const v = await owner.json(sharePath('viewer'), { method: 'PUT', json: { role: 'viewer' } });
      assert.equal(v.status, 200);
      assert.equal(v.body.added, true);
      assert.equal(v.body.role, 'viewer');
      assert.equal(v.body.user_id, ids.viewer);
      assert.equal(v.body.email, 'viewer@example.com');
      const e = await owner.json(sharePath('editor'), { method: 'PUT', json: { role: 'editor' } });
      assert.equal(e.body.added, true);
      const again = await owner.json(sharePath('viewer'), { method: 'PUT', json: { role: 'viewer' } });
      assert.equal(again.body.added, false);
      const list = (await owner.get(`/api/boards/${board.id}/shares`)).body;
      assert.deepEqual(list.map((s: { user_id: number; role: string }) => [s.user_id, s.role]).sort(), [[ids.editor, 'editor'], [ids.viewer, 'viewer']].sort());
    });

    it('shared users see the board in their list with role and owner name', async () => {
      const v = (await viewer.get('/api/boards')).body.find((b: { id: number }) => b.id === board.id);
      assert.equal(v.role, 'viewer');
      assert.equal(v.owner_name, 'Olive Owner');
      const e = (await editor.get('/api/boards')).body.find((b: { id: number }) => b.id === board.id);
      assert.equal(e.role, 'editor');
      assert.equal(v.pin_count, 1);
    });

    it('the stranger still sees nothing', async () => {
      assert.ok(!(await other.get('/api/boards')).body.some((b: { id: number }) => b.id === board.id));
      assert.equal((await other.get(`/api/boards/${board.id}/pins`)).status, 404);
      assert.equal((await other.fetch(`/i/${pin.sha256}`)).status, 404);
      assert.equal((await other.fetch(`/t/400/${pin.sha256}`)).status, 404);
    });
  });

  describe('users directory', () => {
    it('lists everyone but the caller, minimal fields, emails masked for non-admins', async () => {
      const { status, body } = await owner.get('/api/users/directory');
      assert.equal(status, 200);
      const emails = body.map((u: { email: string }) => u.email).sort();
      assert.deepEqual(emails, ['a***@example.com', 'e***@example.com', 'o***@example.com', 'v***@example.com']);
      for (const u of body) assert.deepEqual(Object.keys(u).sort(), ['display_name', 'email', 'id']);
      assert.ok(!body.some((u: { id: number }) => u.id === ids.owner));
    });

    it('shows admins full emails', async () => {
      const { body } = await (await server.adminClient()).get('/api/users/directory');
      const emails = body.map((u: { email: string }) => u.email).sort();
      assert.deepEqual(emails, ['editor@example.com', 'other@example.com', 'owner@example.com', 'viewer@example.com']);
    });

    it('keeps full emails in the owner\'s share list', async () => {
      const shares = (await owner.get(`/api/boards/${board.id}/shares`)).body;
      assert.ok(shares.length);
      for (const s of shares) assert.match(s.email, /^[a-z]+@example\.com$/);
    });

    it('is open to non-admins, closed to anonymous', async () => {
      assert.equal((await other.get('/api/users/directory')).status, 200);
      assert.equal((await server.anon().get('/api/users/directory')).status, 401);
    });
  });
});
