import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pngBuffer } from '../helpers/images.ts';
import { setupBoards, upload } from '../helpers/boards.ts';

let server;
let owner, editor, viewer, other, ids, board, pin, sharePath;

describe('boards and access scoping', () => {
  before(async () => {
    ({ server, owner, editor, viewer, other, ids, board, pin, sharePath } = await setupBoards({ shared: true }));
  });
  after(() => server.stop());

  describe('viewer', () => {
    it('reads the board, its pins and the images', async () => {
      const { status, body } = await viewer.get(`/api/boards/${board.id}/pins`);
      assert.equal(status, 200);
      assert.equal(body.board.role, 'viewer');
      assert.deepEqual(body.pins.map((p) => p.id), [pin.id]);
      assert.equal((await viewer.get(`/api/pins/${pin.id}`)).status, 200);
      const original = await viewer.fetch(`/i/${pin.sha256}`);
      assert.equal(original.status, 200);
      assert.equal(original.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), await pngBuffer({ color: '#112233' }));
      assert.equal((await viewer.fetch(`/t/400/${pin.sha256}`)).headers.get('content-type'), 'image/webp');
    });

    it('cannot add, move, delete or change anything', async () => {
      const bp = `/api/boards/${board.id}`;
      const mine = (await viewer.post('/api/boards', { name: 'Viewer own' })).body;
      assert.equal((await upload(viewer, board.id, await pngBuffer({ color: '#ff0000' }))).status, 404);
      assert.equal((await viewer.post('/api/pins/url', { board_id: board.id, url: 'http://127.0.0.1:1/x.png' })).status, 404);
      assert.equal((await viewer.del(`/api/pins/${pin.id}`)).status, 404);
      assert.equal((await viewer.post('/api/pins/delete', { ids: [pin.id] })).status, 404);
      assert.equal((await viewer.post('/api/pins/move', { ids: [pin.id], board_id: mine.id })).status, 404);
      assert.equal((await viewer.patch(bp, { name: 'nope' })).status, 404);
      assert.equal((await viewer.del(bp)).status, 404);
      assert.equal((await viewer.get(`${bp}/shares`)).status, 404);
      assert.equal((await viewer.json(`${bp}/shares/${ids.other}`, { method: 'PUT', json: { role: 'viewer' } })).status, 404);
      assert.equal((await viewer.del(`${bp}/shares/${ids.editor}`)).status, 404);
      // pins can't be moved *into* a board the viewer can only see
      const vp = (await upload(viewer, mine.id, await pngBuffer({ color: '#0000ff' }))).body;
      assert.equal((await viewer.post('/api/pins/move', { ids: [vp.id], board_id: board.id })).status, 400);
      // nothing changed
      const after = (await owner.get(`${bp}/pins`)).body;
      assert.equal(after.board.name, 'Inspiration');
      assert.equal(after.pins.length, 1);
    });
  });

  describe('editor', () => {
    let added;

    it('adds pins to the shared board, owner sees them', async () => {
      const res = await upload(editor, board.id, await pngBuffer({ color: '#445566' }), '&name=from-editor');
      assert.equal(res.status, 201);
      added = res.body;
      const pins = (await owner.get(`/api/boards/${board.id}/pins`)).body.pins;
      assert.ok(pins.some((p) => p.id === added.id && p.page_title === 'from-editor'));
      assert.equal((await viewer.fetch(`/i/${added.sha256}`)).status, 200);
      assert.equal((await other.fetch(`/i/${added.sha256}`)).status, 404);
    });

    it('cannot rename, delete, set cover, or manage shares', async () => {
      const bp = `/api/boards/${board.id}`;
      assert.equal((await editor.patch(bp, { name: 'nope' })).status, 404);
      assert.equal((await editor.patch(bp, { cover_pin_id: pin.id })).status, 404);
      assert.equal((await editor.del(bp)).status, 404);
      assert.equal((await editor.get(`${bp}/shares`)).status, 404);
      assert.equal((await editor.json(`${bp}/shares/${ids.other}`, { method: 'PUT', json: { role: 'editor' } })).status, 404);
      assert.equal((await editor.del(`${bp}/shares/${ids.viewer}`)).status, 404);
      assert.equal((await owner.get(bp + '/pins')).body.board.name, 'Inspiration');
    });

    it('cannot move pins out of the owner\'s board', async () => {
      const mine = (await editor.post('/api/boards', { name: 'Editor own' })).body;
      assert.equal((await editor.post('/api/pins/move', { ids: [pin.id], board_id: mine.id })).status, 404);
      assert.equal((await owner.get(`/api/boards/${board.id}/pins`)).body.pins.length, 2);
    });

    it('can move their own pin into the shared board (editor on the destination)', async () => {
      const mine = (await editor.post('/api/boards', { name: 'Editor staging' })).body;
      const p = (await upload(editor, mine.id, await pngBuffer({ color: '#778899' }))).body;
      const res = await editor.post('/api/pins/move', { ids: [p.id], board_id: board.id });
      assert.equal(res.status, 200);
      assert.equal(res.body.moved, 1);
      assert.ok((await viewer.get(`/api/boards/${board.id}/pins`)).body.pins.some((x) => x.id === p.id));
      await owner.post('/api/pins/delete', { ids: [p.id] });
    });

    it('can delete pins on the shared board', async () => {
      assert.equal((await editor.del(`/api/pins/${added.id}`)).status, 200);
      assert.equal((await viewer.get(`/api/pins/${added.id}`)).status, 404);
      assert.equal((await viewer.fetch(`/i/${added.sha256}`)).status, 404);
    });

    it('bulk delete is all-or-nothing across boards', async () => {
      const mine = (await owner.post('/api/boards', { name: 'Private' })).body;
      const priv = (await upload(owner, mine.id, await pngBuffer({ color: '#abcdef' }))).body;
      const extra = (await upload(owner, board.id, await pngBuffer({ color: '#fedcba' }))).body;
      assert.equal((await editor.post('/api/pins/delete', { ids: [extra.id, priv.id] })).status, 404);
      assert.equal((await owner.get(`/api/pins/${extra.id}`)).status, 200);
      assert.equal((await editor.post('/api/pins/delete', { ids: [extra.id] })).body.deleted, 1);
      assert.equal((await owner.get(`/api/pins/${priv.id}`)).status, 200);
    });

    it('an upgrade from viewer to editor and back takes effect at once', async () => {
      const buf = await pngBuffer({ color: '#13579b' });
      assert.equal((await upload(viewer, board.id, buf)).status, 404);
      await owner.json(sharePath('viewer'), { method: 'PUT', json: { role: 'editor' } });
      const res = await upload(viewer, board.id, buf);
      assert.equal(res.status, 201);
      await owner.json(sharePath('viewer'), { method: 'PUT', json: { role: 'viewer' } });
      assert.equal((await upload(viewer, board.id, buf)).status, 404);
      assert.equal((await viewer.del(`/api/pins/${res.body.id}`)).status, 404);
      await owner.del(`/api/pins/${res.body.id}`);
    });
  });
});
