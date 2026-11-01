import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from '../helpers/server.js';
import { jpegBuffer, pngBuffer } from '../helpers/images.js';
import { newBoard, originalFile, rawPost, upload } from '../helpers/pins.js';

describe('pins', () => {
  let server, alice, bob, board;
  before(async () => {
    server = await startServer();
    alice = await server.createUser('alice@example.com', 'alice-password-1');
    bob = await server.createUser('bob@example.com', 'bob-password-1');
    board = await newBoard(alice, 'Alice board');
  });
  after(() => server.stop());

  it('uploads PNG and JPEG and reports their metadata', async () => {
    const png = await upload(alice, board.id, await pngBuffer({ width: 30, height: 20, color: '#ff0000' }), '&name=red&source_url=https%3A%2F%2Fexample.com%2Fp');
    assert.equal(png.status, 201);
    assert.equal(png.body.mime, 'image/png');
    assert.equal(png.body.width, 30);
    assert.equal(png.body.height, 20);
    assert.equal(png.body.board_id, board.id);
    assert.equal(png.body.page_title, 'red');
    assert.equal(png.body.source_url, 'https://example.com/p');
    assert.match(png.body.sha256, /^[0-9a-f]{64}$/);

    const jpg = await upload(alice, board.id, await jpegBuffer({ width: 16, height: 40, color: '#00ff00' }));
    assert.equal(jpg.status, 201);
    assert.equal(jpg.body.mime, 'image/jpeg');
    assert.equal(jpg.body.height, 40);

    const got = await alice.get(`/api/pins/${png.body.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.sha256, png.body.sha256);
  });

  it('rejects non-images, empty bodies, missing board and oversize uploads', async () => {
    assert.equal((await upload(alice, board.id, Buffer.from('definitely not an image'))).status, 415);
    assert.equal((await upload(alice, board.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"/>'))).status, 415);
    assert.equal((await upload(alice, board.id, Buffer.alloc(0))).status, 400);
    const noBoard = await rawPost(alice, '/api/pins/upload', await pngBuffer());
    assert.equal(noBoard.status, 400);
    assert.equal((await upload(alice, 999999, await pngBuffer())).status, 404);
    // another user's board is simply not found
    assert.equal((await upload(bob, board.id, await pngBuffer())).status, 404);
    assert.equal((await upload(server.anon(), board.id, await pngBuffer())).status, 401);
    const big = await upload(alice, board.id, Buffer.alloc(51 * 1024 * 1024));
    assert.equal(big.status, 413);
  });

  it('cannot delete or move another user\'s pins', async () => {
    const mine = (await upload(alice, board.id, await pngBuffer({ color: '#010203' }))).body;
    const bobBoard = await newBoard(bob, 'Bob target');
    assert.equal((await bob.del(`/api/pins/${mine.id}`)).status, 404);
    assert.equal((await bob.post('/api/pins/delete', { ids: [mine.id] })).status, 404);
    assert.equal((await bob.post('/api/pins/move', { ids: [mine.id], board_id: bobBoard.id })).status, 404);
    assert.equal((await alice.get(`/api/pins/${mine.id}`)).status, 200);
    // my pin into someone else's board is refused too
    assert.equal((await alice.post('/api/pins/move', { ids: [mine.id], board_id: bobBoard.id })).status, 400);
  });

  it('bulk deletes and moves between boards, all or nothing', async () => {
    const src = await newBoard(alice, 'Src');
    const dst = await newBoard(alice, 'Dst');
    const pins = [];
    for (const color of ['#111111', '#222222', '#333333']) pins.push((await upload(alice, src.id, await pngBuffer({ color }))).body);
    const bobPin = (await upload(bob, (await newBoard(bob, 'B2')).id, await pngBuffer({ color: '#999999' }))).body;

    const moved = await alice.post('/api/pins/move', { ids: [pins[0].id, pins[1].id], board_id: dst.id });
    assert.deepEqual(moved.body, { moved: 2 });
    assert.equal((await alice.get(`/api/boards/${dst.id}/pins`)).body.pins.length, 2);
    assert.equal((await alice.get(`/api/boards/${src.id}/pins`)).body.pins.length, 1);
    assert.equal((await alice.post('/api/pins/move', { ids: [pins[2].id], board_id: 999999 })).status, 400);
    assert.equal((await alice.post('/api/pins/move', { ids: [], board_id: dst.id })).status, 400);
    assert.equal((await alice.post('/api/pins/move', { ids: ['x'], board_id: dst.id })).status, 400);

    // a foreign id poisons the whole request
    assert.equal((await alice.post('/api/pins/delete', { ids: [pins[2].id, bobPin.id] })).status, 404);
    assert.equal((await alice.get(`/api/pins/${pins[2].id}`)).status, 200);
    assert.equal((await alice.get(`/api/pins/${bobPin.id}`)).status, 404);

    const del = await alice.post('/api/pins/delete', { ids: pins.map((p) => p.id) });
    assert.deepEqual(del.body, { deleted: 3 });
    for (const p of pins) assert.ok(!fs.existsSync(originalFile(server, p.sha256)));
    assert.equal((await alice.post('/api/pins/delete', { ids: [] })).status, 400);
  });
});
