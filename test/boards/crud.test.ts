import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupBoards } from '../helpers/boards.ts';
import type { Boards } from '../helpers/boards.ts';
import type { Client, Server } from '../helpers/server.ts';
import { pngBuffer } from '../helpers/images.ts';
import { newBoard, upload } from '../helpers/pins.ts';

let server: Server;
let owner: Client, board: Boards['board'], pin: Boards['pin'];

describe('boards and access scoping', () => {
  before(async () => {
    ({ server, owner, board, pin } = await setupBoards());
  });
  after(() => server.stop());

  describe('owner CRUD', () => {
    it('creates, lists, renames and deletes a board', async () => {
      const created = await owner.post('/api/boards', { name: '  Scratch  ' });
      assert.equal(created.status, 201);
      assert.equal(created.body.name, 'Scratch');
      assert.equal(created.body.role, 'owner');
      assert.equal(created.body.pin_count, 0);

      const list = await owner.get('/api/boards');
      assert.ok(list.body.some((b: { id: number }) => b.id === created.body.id));

      const renamed = await owner.patch(`/api/boards/${created.body.id}`, { name: 'Renamed' });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.name, 'Renamed');

      assert.equal((await owner.del(`/api/boards/${created.body.id}`)).status, 200);
      assert.equal((await owner.get(`/api/boards/${created.body.id}/pins`)).status, 404);
      assert.ok(!(await owner.get('/api/boards')).body.some((b: { id: number }) => b.id === created.body.id));
    });

    it('validates names', async () => {
      assert.equal((await owner.post('/api/boards', { name: '   ' })).status, 400);
      assert.equal((await owner.post('/api/boards', { name: 'x'.repeat(101) })).status, 400);
      assert.equal((await owner.patch(`/api/boards/${board.id}`, { name: '' })).status, 400);
    });

    it('lists the owner\'s pins, and sets and clears the cover', async () => {
      const { status, body } = await owner.get(`/api/boards/${board.id}/pins`);
      assert.equal(status, 200);
      assert.equal(body.board.role, 'owner');
      assert.deepEqual(body.pins.map((p: { id: number }) => p.id), [pin.id]);
      const set = await owner.patch(`/api/boards/${board.id}`, { cover_pin_id: pin.id });
      assert.equal(set.body.cover_pin_id, pin.id);
      const cleared = await owner.patch(`/api/boards/${board.id}`, { cover_pin_id: null });
      assert.equal(cleared.body.cover_pin_id, null);
    });

    it('shows the chosen cover, else the newest pin, else none', async () => {
      const covers = await newBoard(owner, 'Covers');
      const path = `/api/boards/${covers.id}`;
      const listed = async () => (await owner.get('/api/boards')).body.find((b: { id: number }) => b.id === covers.id).cover;
      assert.equal(await listed(), null);

      const older = (await upload(owner, covers.id, await pngBuffer({ width: 40, height: 30, color: '#112233' }))).body;
      const newer = (await upload(owner, covers.id, await pngBuffer({ width: 20, height: 50, color: '#332211' }))).body;
      assert.deepEqual(await listed(), { sha256: newer.sha256, width: 20, height: 50 });

      const chosen = await owner.patch(path, { cover_pin_id: older.id });
      assert.deepEqual(chosen.body.cover, { sha256: older.sha256, width: 40, height: 30 });
      assert.deepEqual(await listed(), { sha256: older.sha256, width: 40, height: 30 });
      assert.deepEqual((await owner.get('/api/boards?sort=recent')).body.find((b: { id: number }) => b.id === covers.id).cover,
        { sha256: older.sha256, width: 40, height: 30 });
    });

    it('a rejected PATCH changes nothing, the name included', async () => {
      const elsewhere = await newBoard(owner, 'Elsewhere');
      const foreign = (await upload(owner, elsewhere.id, await pngBuffer({ color: '#445566' }))).body;
      const path = `/api/boards/${board.id}`;
      const before = (await owner.get(`${path}/pins`)).body.board.name;
      assert.equal((await owner.patch(path, { name: 'Renamed', cover_pin_id: foreign.id })).status, 400);
      assert.equal((await owner.patch(path, { name: 'Renamed', cover_pin_id: 999999 })).status, 400);
      assert.equal((await owner.get(`${path}/pins`)).body.board.name, before);
    });
  });
});
