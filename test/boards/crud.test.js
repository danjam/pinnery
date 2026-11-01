import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupBoards } from '../helpers/boards.js';

let server;
let owner, board, pin;

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
      assert.ok(list.body.some((b) => b.id === created.body.id));

      const renamed = await owner.patch(`/api/boards/${created.body.id}`, { name: 'Renamed' });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.name, 'Renamed');

      assert.equal((await owner.del(`/api/boards/${created.body.id}`)).status, 200);
      assert.equal((await owner.get(`/api/boards/${created.body.id}/pins`)).status, 404);
      assert.ok(!(await owner.get('/api/boards')).body.some((b) => b.id === created.body.id));
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
      assert.deepEqual(body.pins.map((p) => p.id), [pin.id]);
      const set = await owner.patch(`/api/boards/${board.id}`, { cover_pin_id: pin.id });
      assert.equal(set.body.cover_pin_id, pin.id);
      const cleared = await owner.patch(`/api/boards/${board.id}`, { cover_pin_id: null });
      assert.equal(cleared.body.cover_pin_id, null);
    });
  });
});
