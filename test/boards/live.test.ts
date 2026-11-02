import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pngBuffer } from '../helpers/images.ts';
import { setupBoards, upload } from '../helpers/boards.ts';
import type { Boards } from '../helpers/boards.ts';
import { listen, isBoard, isBoards } from '../helpers/events.ts';
import type { Listener, LiveEvent } from '../helpers/events.ts';
import type { Client, JsonResult, Server } from '../helpers/server.ts';
import { createZipWriter } from '../../src/zip.ts';

// Live updates (src/live.ts): who gets which ping over GET /api/events.
//
// A ping is sent before the write's response, on another connection, so it can arrive first:
// `pinged` notes where each stream is before the write and looks for the ping from there.
//
// "Gets no ping" is checked with a sentinel rather than a sleep: pings on one stream arrive in
// order, so once a later ping (the user renaming a board of their own) has arrived, an earlier one
// that never came was never sent.

let server: Server;
let owner: Client, editor: Client, viewer: Client, other: Client, ids: Boards['ids'], board: Boards['board'], sharePath: Boards['sharePath'];
const open: Listener[] = [];

const watch = async (client: Client, headers?: Record<string, string>) => {
  const l = await listen(client, headers);
  open.push(l);
  return l;
};

type Expect = [Listener, (e: LiveEvent) => boolean];
// Run a write, check its status, and wait for each expected ping.
async function pinged(write: () => Promise<JsonResult>, status: number, ...expect: Expect[]) {
  const at = expect.map(([l]) => l.seen.length);
  const res = await write();
  assert.equal(res.status, status, JSON.stringify(res.body));
  await Promise.all(expect.map(([l, match], i) => l.next(match, { since: at[i] })));
  return res;
}

// The sentinel renames a board of the client's own, made once: a new board each time could reuse
// the id of one a test just deleted (SQLite hands out the highest id + 1).
const sentinels = new Map<Client, number>();
let renames = 0;
async function settle(client: Client, l: Listener) {
  let id = sentinels.get(client);
  if (!id) {
    id = (await client.post('/api/boards', { name: 'sentinel' })).body.id as number;
    sentinels.set(client, id);
  }
  await pinged(() => client.patch(`/api/boards/${id}`, { name: `sentinel ${++renames}` }), 200, [l, isBoard(id)]);
}
const heard = (l: Listener, id: number, since = 0) => l.seen.slice(since).some(isBoard(id));
const png = (color: string) => pngBuffer({ color });

describe('live updates', () => {
  before(async () => {
    ({ server, owner, editor, viewer, other, ids, board, sharePath } = await setupBoards({ shared: true }));
  });
  after(async () => {
    for (const l of open) l.close();
    await server.stop();
  });

  it('refuses a request without a session', async () => {
    const res = await server.anon().fetch('/api/events');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorised' });
  });

  it('streams uncompressed, so a ping arrives as soon as it is sent', async () => {
    const l = await watch(owner, { 'accept-encoding': 'br, gzip' });
    assert.match(l.res.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(l.res.headers.get('content-encoding'), null);
    assert.match(l.res.headers.get('cache-control') ?? '', /no-transform/);
    // A buffered stream would hold this until it filled or closed: never, within the wait.
    const img = await png('#010203');
    await pinged(() => upload(owner, board.id, img), 201, [l, isBoard(board.id)]);
    l.close();
  });

  it('pings everyone who can see a board, and nobody else', async () => {
    const [o, e, v, x] = await Promise.all([owner, editor, viewer, other].map((c) => watch(c)));
    const all = (match: (e: LiveEvent) => boolean): Expect[] => [o, e, v].map((l) => [l, match]);
    // An editor's upload reaches the owner, the editor and the viewer; so does a rename.
    const img = await png('#0a0b0c');
    await pinged(() => upload(editor, board.id, img), 201, ...all(isBoard(board.id)));
    await pinged(() => owner.patch(`/api/boards/${board.id}`, { name: 'Renamed' }), 200, ...all(isBoard(board.id)));
    await settle(other, x);
    assert.ok(!heard(x, board.id), 'a stranger heard about the board');
    for (const l of [o, e, v, x]) l.close();
  });

  it('pings for deleting and moving pins, on every board involved', async () => {
    const o = await watch(owner);
    const v = await watch(viewer);
    const x = await watch(other);
    const second = (await pinged(() => owner.post('/api/boards', { name: 'Second' }), 201, [o, isBoards])).body;
    const [p1, p2, p3] = await Promise.all(['#111111', '#222222', '#333333'].map(async (c) => (await upload(owner, board.id, await png(c))).body));
    // Moving: the source and destination; the viewer sees the pin leave, not where it went.
    await pinged(() => owner.post('/api/pins/move', { ids: [p1.id], board_id: second.id }), 200, [o, isBoard(board.id)], [o, isBoard(second.id)], [v, isBoard(board.id)]);
    await pinged(() => owner.del(`/api/pins/${p2.id}`), 200, [o, isBoard(board.id)], [v, isBoard(board.id)]);
    await pinged(() => owner.post('/api/pins/delete', { ids: [p3.id, p1.id] }), 200, [o, isBoard(board.id)], [o, isBoard(second.id)], [v, isBoard(board.id)]);
    await settle(other, x);
    await settle(viewer, v);
    assert.ok(!heard(x, board.id) && !heard(x, second.id), 'a stranger heard about the boards');
    assert.ok(!heard(v, second.id), 'the viewer heard about a board not shared with them');
    for (const l of [o, v, x]) l.close();
  });

  it('pings someone a board is shared with, and the one it is taken from', async () => {
    const x = await watch(other);
    // Shared: the new member's home page gains a board.
    await pinged(() => owner.json(sharePath('other'), { method: 'PUT', json: { role: 'viewer' } }), 200, [x, isBoards], [x, isBoard(board.id)]);
    // A role change: their open board page re-reads what they may do.
    await pinged(() => owner.json(sharePath('other'), { method: 'PUT', json: { role: 'editor' } }), 200, [x, isBoard(board.id)]);
    // Unshared: they still get the ping, so their open page can leave...
    await pinged(() => owner.del(sharePath('other')), 200, [x, isBoard(board.id)], [x, isBoards]);
    // ...and nothing after that.
    const since = x.seen.length;
    assert.equal((await upload(owner, board.id, await png('#444444'))).status, 201);
    await settle(other, x);
    assert.ok(!heard(x, board.id, since), 'heard about a board after losing it');
    x.close();
  });

  it('pings everyone who could see a deleted board, and the board its pins moved to', async () => {
    const doomed = (await owner.post('/api/boards', { name: 'Doomed' })).body;
    const dest = (await owner.post('/api/boards', { name: 'Dest' })).body;
    await upload(owner, doomed.id, await png('#555555'));
    await owner.json(`/api/boards/${doomed.id}/shares/${ids.viewer}`, { method: 'PUT', json: { role: 'viewer' } });
    const o = await watch(owner);
    const v = await watch(viewer);
    const x = await watch(other);
    await pinged(() => owner.json(`/api/boards/${doomed.id}`, { method: 'DELETE', json: { move_to: dest.id } }), 200,
      [o, isBoard(doomed.id)], [o, isBoard(dest.id)], [v, isBoard(doomed.id)], [v, isBoards]);
    await settle(other, x);
    await settle(viewer, v);
    assert.ok(!heard(x, doomed.id), 'a stranger heard about the deleted board');
    assert.ok(!heard(v, dest.id), 'the viewer heard about the destination board');
    for (const l of [o, v, x]) l.close();
  });

  it('pings for picks: a board made on the pick page, and the pin committed to it', async () => {
    const o = await watch(owner);
    const pick = await owner.json('/api/pick/upload', { method: 'POST', body: await png('#666666'), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(pick.status, 201);
    const anon = server.anon();
    const made = (await pinged(() => anon.post(`/pick/${pick.body.token}/boards`, { name: 'Picked' }), 201, [o, isBoards])).body;
    assert.ok(heard(o, made.id));
    await pinged(() => anon.post(`/pick/${pick.body.token}/commit`, { board_id: made.id }), 201, [o, isBoard(made.id)]);
    o.close();
  });

  it('pings for an import: the boards it creates and the ones it adds to', async () => {
    const chunks: Buffer[] = [];
    const z = createZipWriter({ write: (b: Uint8Array) => { chunks.push(Buffer.from(b)); return true; }, on() {}, off() {} });
    await z.add('a/red.png', await png('#ff0000'));
    await z.add('b/blue.png', await png('#0000ff'));
    await z.add('pins.json', Buffer.from(JSON.stringify({ version: 1, boards: [
      { name: 'Imported', pins: [{ file: 'a/red.png' }] },
      { name: 'Renamed', pins: [{ file: 'b/blue.png' }] },   // the shared board: merged by name
    ] })));
    await z.end();
    const o = await watch(owner);
    const v = await watch(viewer);
    const x = await watch(other);
    const res = await pinged(() => owner.json('/api/import', { method: 'POST', body: Buffer.concat(chunks), headers: { 'content-type': 'application/zip' } }), 200,
      [o, isBoards], [o, isBoard(board.id)], [v, isBoard(board.id)]);
    assert.deepEqual(res.body, { boards_created: 1, boards_merged: 1, pins_added: 2, pins_skipped: 0 });
    const imported = (await owner.get('/api/boards')).body.find((b: { name: string }) => b.name === 'Imported');
    assert.ok(heard(o, imported.id));
    await settle(other, x);
    await settle(viewer, v);
    assert.ok(!heard(x, imported.id) && !heard(x, board.id), 'a stranger heard about the import');
    assert.ok(!heard(v, imported.id), 'the viewer heard about a board not shared with them');
    for (const l of [o, v, x]) l.close();
  });

  it('pings the people a deleted user shared boards with, and ends the deleted user’s stream', async () => {
    const admin = await server.adminClient();
    const leaver = await server.createUser('leaver@example.com', 'leaver-password-1');
    const leaverId = (await leaver.get('/api/me')).body.id;
    const theirs = (await leaver.post('/api/boards', { name: 'Theirs' })).body;
    assert.equal((await leaver.json(`/api/boards/${theirs.id}/shares/${ids.viewer}`, { method: 'PUT', json: { role: 'viewer' } })).status, 200);
    const gone = await watch(leaver);
    const v = await watch(viewer);
    const x = await watch(other);
    await pinged(() => admin.del(`/api/users/${leaverId}`), 200, [v, isBoard(theirs.id)], [v, isBoards]);
    await gone.ended();
    assert.ok(!heard(gone, theirs.id), 'the deleted user was still pinged');
    await settle(other, x);
    assert.ok(!heard(x, theirs.id), 'a stranger heard about the deleted user’s board');
    for (const l of [v, x]) l.close();
  });

  it('ends a stream once its session is signed out', async () => {
    const quitter = await server.createUser('quitter@example.com', 'quitter-password-1');
    const b = (await quitter.post('/api/boards', { name: 'Mine' })).body;
    const second = await server.login('quitter@example.com', 'quitter-password-1');
    const l = await watch(quitter);
    assert.equal((await quitter.post('/api/logout')).status, 200);
    // The next ping for this user finds the session gone and closes the stream instead.
    assert.equal((await upload(second, b.id, await png('#777777'))).status, 201);
    await l.ended();
    assert.ok(!heard(l, b.id));
  });
});
