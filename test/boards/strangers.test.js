import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pngBuffer } from '../helpers/images.ts';
import { setupBoards, upload } from '../helpers/boards.ts';

let server;
let owner, other, ids, board, pin;

describe('boards and access scoping', () => {
  before(async () => {
    ({ server, owner, other, ids, board, pin } = await setupBoards());
  });
  after(() => server.stop());

  describe('a stranger (no share)', () => {
    it('sees nothing of the board in their list', async () => {
      assert.ok(!(await other.get('/api/boards')).body.some((b) => b.id === board.id));
    });

    it('gets 404 (not 403) for every board and pin route', async () => {
      const bp = `/api/boards/${board.id}`;
      const checks = [
        other.get(`${bp}/pins`),
        other.patch(bp, { name: 'hijack' }),
        other.del(bp),
        other.get(`${bp}/shares`),
        other.json(`${bp}/shares/${ids.other}`, { method: 'PUT', json: { role: 'editor' } }),
        other.json(`${bp}/shares/${ids.viewer}`, { method: 'PUT', json: { role: 'viewer' } }),
        other.del(`${bp}/shares/${ids.viewer}`),
        other.get(`/api/pins/${pin.id}`),
        other.del(`/api/pins/${pin.id}`),
        other.post('/api/pins/delete', { ids: [pin.id] }),
        other.post('/api/pins/move', { ids: [pin.id], board_id: board.id }),
        upload(other, board.id, await pngBuffer({ color: '#aa0000' })),
      ];
      for (const r of await Promise.all(checks)) assert.equal(r.status, 404);
    });

    it('cannot fetch the image or thumbnails', async () => {
      for (const p of [`/i/${pin.sha256}`, `/t/400/${pin.sha256}`, `/t/800/${pin.sha256}`]) {
        assert.equal((await other.fetch(p)).status, 404, p);
        assert.equal((await owner.fetch(p)).status, 200, p);
      }
    });

    it('cannot pin into the board via a move or board delete move_to', async () => {
      const mine = (await other.post('/api/boards', { name: 'Mine' })).body;
      const mp = (await upload(other, mine.id, await pngBuffer({ color: '#00aa00' }))).body;
      assert.equal((await other.post('/api/pins/move', { ids: [mp.id], board_id: board.id })).status, 400);
      assert.equal((await other.json(`/api/boards/${mine.id}`, { method: 'DELETE', json: { move_to: board.id } })).status, 400);
      assert.equal((await other.get(`/api/boards/${mine.id}/pins`)).body.pins.length, 1);
    });

    it('unauthenticated requests are 401', async () => {
      const anon = server.anon();
      assert.equal((await anon.get('/api/boards')).status, 401);
      assert.equal((await anon.get(`/i/${pin.sha256}`)).status, 401);
    });

    it('malformed and unknown ids are 404 too', async () => {
      for (const id of ['0', '-1', 'abc', '99999']) assert.equal((await owner.get(`/api/boards/${id}/pins`)).status, 404, id);
      assert.equal((await owner.get('/api/pins/99999')).status, 404);
      assert.equal((await owner.fetch(`/i/${'0'.repeat(64)}`)).status, 404);
      assert.equal((await owner.fetch('/i/not-a-sha')).status, 404);
      assert.equal((await owner.fetch(`/t/123/${pin.sha256}`)).status, 404);
    });
  });
});
