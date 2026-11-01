import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pngBuffer } from '../helpers/images.js';
import { setupBoards, upload } from '../helpers/boards.js';

let server;
let owner, editor, viewer, other, ids, board, pin, sharePath;

describe('boards and access scoping', () => {
  before(async () => {
    ({ server, owner, editor, viewer, other, ids, board, pin, sharePath } = await setupBoards({ shared: true }));
  });
  after(() => server.stop());

  describe('revoking', () => {
    it('removing a share cuts access immediately', async () => {
      assert.equal((await viewer.get(`/api/boards/${board.id}/pins`)).status, 200);
      assert.equal((await owner.del(sharePath('viewer'))).status, 200);
      assert.equal((await viewer.get(`/api/boards/${board.id}/pins`)).status, 404);
      assert.equal((await viewer.get(`/api/pins/${pin.id}`)).status, 404);
      assert.equal((await viewer.fetch(`/i/${pin.sha256}`)).status, 404);
      assert.equal((await viewer.fetch(`/t/400/${pin.sha256}`)).status, 404);
      assert.ok(!(await viewer.get('/api/boards')).body.some((b) => b.id === board.id));
      assert.equal((await owner.del(sharePath('viewer'))).status, 404); // already gone
      const left = (await owner.get(`/api/boards/${board.id}/shares`)).body;
      assert.deepEqual(left.map((s) => s.user_id), [ids.editor]);
    });

    it('a removed editor can no longer add pins', async () => {
      assert.equal((await upload(editor, board.id, await pngBuffer({ color: '#222222' }))).status, 201);
      await owner.del(sharePath('editor'));
      assert.equal((await upload(editor, board.id, await pngBuffer({ color: '#333333' }))).status, 404);
    });
  });

  describe('deleting a board', () => {
    it('removes its pins and makes their images unreachable, even for former sharees', async () => {
      const b = (await owner.post('/api/boards', { name: 'Doomed' })).body;
      const p = (await upload(owner, b.id, await pngBuffer({ color: '#c0ffee' }))).body;
      await owner.json(`/api/boards/${b.id}/shares/${ids.viewer}`, { method: 'PUT', json: { role: 'viewer' } });
      assert.equal((await viewer.fetch(`/i/${p.sha256}`)).status, 200);

      assert.equal((await owner.del(`/api/boards/${b.id}`)).status, 200);
      assert.equal((await owner.get(`/api/pins/${p.id}`)).status, 404);
      assert.equal((await owner.fetch(`/i/${p.sha256}`)).status, 404);
      assert.equal((await viewer.get(`/api/boards/${b.id}/pins`)).status, 404);
      assert.equal((await viewer.fetch(`/i/${p.sha256}`)).status, 404);
      assert.ok(!(await viewer.get('/api/boards')).body.some((x) => x.id === b.id));
    });

    it('with move_to re-homes the pins instead', async () => {
      const a = (await owner.post('/api/boards', { name: 'From' })).body;
      const dest = (await owner.post('/api/boards', { name: 'To' })).body;
      const p = (await upload(owner, a.id, await pngBuffer({ color: '#bada55' }))).body;
      assert.equal((await owner.json(`/api/boards/${a.id}`, { method: 'DELETE', json: { move_to: dest.id } })).status, 200);
      assert.equal((await owner.get(`/api/pins/${p.id}`)).body.board_id, dest.id);
      assert.equal((await owner.fetch(`/i/${p.sha256}`)).status, 200);
    });

    it('rejects move_to a board the caller cannot edit', async () => {
      const a = (await owner.post('/api/boards', { name: 'Keep' })).body;
      const theirs = (await other.post('/api/boards', { name: 'Theirs' })).body;
      assert.equal((await owner.json(`/api/boards/${a.id}`, { method: 'DELETE', json: { move_to: theirs.id } })).status, 400);
      assert.equal((await owner.get(`/api/boards/${a.id}/pins`)).status, 200);
    });

    it('a shared image survives while another board still has it', async () => {
      const buf = await pngBuffer({ color: '#010203' });
      const a = (await owner.post('/api/boards', { name: 'Dup A' })).body;
      const b = (await other.post('/api/boards', { name: 'Dup B' })).body;
      const pa = (await upload(owner, a.id, buf)).body;
      const pb = (await upload(other, b.id, buf)).body;
      assert.equal(pa.sha256, pb.sha256);
      await owner.del(`/api/boards/${a.id}`);
      assert.equal((await owner.fetch(`/i/${pa.sha256}`)).status, 404); // owner has no pin with it any more
      assert.equal((await other.fetch(`/i/${pb.sha256}`)).status, 200);
    });
  });
});
