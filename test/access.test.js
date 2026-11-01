import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.js';
import { pngBuffer } from './helpers/images.js';

let server;
let owner, editor, viewer, other; // other: never shared with
let ids;                          // user ids by name
let board, pin;                   // owner's board and a pin on it

const upload = (client, boardId, buf, query = '') =>
  client.json(`/api/pins/upload?board_id=${boardId}${query}`, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } });

describe('boards and access scoping', () => {
  before(async () => {
    server = await startServer();
    owner = await server.createUser('owner@example.com', 'owner-password-1', { displayName: 'Olive Owner' });
    editor = await server.createUser('editor@example.com', 'editor-password-1', { displayName: 'Edie Editor' });
    viewer = await server.createUser('viewer@example.com', 'viewer-password-1', { displayName: 'Vic Viewer' });
    other = await server.createUser('other@example.com', 'other-password-1', { displayName: 'Otto Other' });
    ids = {};
    for (const [k, c] of Object.entries({ owner, editor, viewer, other })) ids[k] = (await c.get('/api/me')).body.id;

    board = (await owner.post('/api/boards', { name: 'Inspiration' })).body;
    const res = await upload(owner, board.id, await pngBuffer({ color: '#112233' }), '&name=first');
    assert.equal(res.status, 201);
    pin = res.body;
  });
  after(() => server.stop());

  const sharePath = (who) => `/api/boards/${board.id}/shares/${ids[who]}`;

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

  describe('sharing', () => {
    it('only the owner lists shares; starts empty', async () => {
      assert.deepEqual((await owner.get(`/api/boards/${board.id}/shares`)).body, []);
    });

    it('rejects bad roles, unknown users and self-sharing', async () => {
      const put = (path, json) => owner.json(path, { method: 'PUT', json });
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
      assert.deepEqual(list.map((s) => [s.user_id, s.role]).sort(), [[ids.editor, 'editor'], [ids.viewer, 'viewer']].sort());
    });

    it('shared users see the board in their list with role and owner name', async () => {
      const v = (await viewer.get('/api/boards')).body.find((b) => b.id === board.id);
      assert.equal(v.role, 'viewer');
      assert.equal(v.owner_name, 'Olive Owner');
      const e = (await editor.get('/api/boards')).body.find((b) => b.id === board.id);
      assert.equal(e.role, 'editor');
      assert.equal(v.pin_count, 1);
    });

    it('the stranger still sees nothing', async () => {
      assert.ok(!(await other.get('/api/boards')).body.some((b) => b.id === board.id));
      assert.equal((await other.get(`/api/boards/${board.id}/pins`)).status, 404);
      assert.equal((await other.fetch(`/i/${pin.sha256}`)).status, 404);
      assert.equal((await other.fetch(`/t/400/${pin.sha256}`)).status, 404);
    });
  });

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

  describe('users directory', () => {
    it('lists everyone but the caller, minimal fields', async () => {
      const { status, body } = await owner.get('/api/users/directory');
      assert.equal(status, 200);
      const emails = body.map((u) => u.email).sort();
      assert.deepEqual(emails, ['admin@example.com', 'editor@example.com', 'other@example.com', 'viewer@example.com']);
      for (const u of body) assert.deepEqual(Object.keys(u).sort(), ['display_name', 'email', 'id']);
      assert.ok(!body.some((u) => u.id === ids.owner));
    });

    it('is open to non-admins, closed to anonymous', async () => {
      assert.equal((await other.get('/api/users/directory')).status, 200);
      assert.equal((await server.anon().get('/api/users/directory')).status, 401);
    });
  });

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
