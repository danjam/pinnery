import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer } from '../helpers/server.ts';
import type { Client, Server } from '../helpers/server.ts';
import { avifBuffer, jpegBuffer, pngBuffer } from '../helpers/images.ts';
import { newBoard, originalFile, rawPost, upload, type BoardRef } from '../helpers/pins.ts';

describe('pins', () => {
  let server: Server, alice: Client, bob: Client, board: BoardRef;
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

  it('keeps only http(s) source URLs', async () => {
    const src = async (sourceUrl: string) => (await upload(alice, board.id, await pngBuffer({ color: '#0c0c0c' }), `&source_url=${encodeURIComponent(sourceUrl)}`)).body.source_url;
    assert.equal(await src('javascript:alert(1)'), null);
    assert.equal(await src('data:text/html,<b>hi</b>'), null);
    assert.equal(await src('not a url'), null);
    assert.equal(await src('http://example.com/a'), 'http://example.com/a');
    const parked = await rawPost(alice, '/api/pick/upload?source_url=javascript%3Aalert(1)', await pngBuffer({ color: '#0d0d0d' }));
    const commit = await server.anon().post(`/pick/${parked.body.token}/commit`, { board_id: board.id });
    assert.equal(commit.body.pin.source_url, null);
  });

  it('uploads AVIF and makes its thumbnails', async () => {
    const r = await upload(alice, board.id, await avifBuffer({ width: 40, height: 30, color: '#808000' }));
    assert.equal(r.status, 201);
    assert.equal(r.body.mime, 'image/avif');
    assert.equal(r.body.width, 40);
    assert.equal(r.body.height, 30);
    const orig = await alice.fetch(`/i/${r.body.sha256}`);
    assert.equal(orig.headers.get('content-type'), 'image/avif');
    // made at save time, and served as WebP
    for (const size of [400, 800]) {
      assert.ok(fs.existsSync(path.join(server.dataDir, 'thumbs', r.body.sha256.slice(0, 2), `${r.body.sha256}-${size}.webp`)), `thumb ${size}`);
      const t = await alice.fetch(`/t/${size}/${r.body.sha256}`);
      assert.equal(t.status, 200);
      assert.equal(t.headers.get('content-type'), 'image/webp');
    }
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

  it('refuses images that would decode to more than the pixel limit', async () => {
    // A tiny PNG whose header claims 20000x20000 (400 MP): rewrite IHDR's size and its CRC.
    const png = await pngBuffer({ width: 8, height: 8 });
    png.writeUInt32BE(20000, 16);
    png.writeUInt32BE(20000, 20);
    png.writeUInt32BE(zlib.crc32(png.subarray(12, 29)), 29);
    const r = await upload(alice, board.id, png);
    assert.equal(r.status, 413);
    assert.match(r.body.error, /megapixels/);
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

    assert.equal((await alice.patch(`/api/boards/${src.id}`, { cover_pin_id: pins[1].id })).status, 200);
    const moved = await alice.post('/api/pins/move', { ids: [pins[0].id, pins[1].id], board_id: dst.id });
    assert.deepEqual(moved.body, { moved: 2 });
    // a board whose cover moved away falls back to its newest pin
    const srcAfter = (await alice.get('/api/boards')).body.find((b: { id: number }) => b.id === src.id);
    assert.equal(srcAfter.cover_pin_id, null);
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

  it('caps bulk requests at 1000 ids', async () => {
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    const del = await alice.post('/api/pins/delete', { ids });
    assert.equal(del.status, 400);
    assert.match(del.body.error, /at most 1000/);
    assert.equal((await alice.post('/api/pins/move', { ids, board_id: board.id })).status, 400);
    // 1000 is still allowed through to the access check (these ids aren't alice's: not found)
    assert.equal((await alice.post('/api/pins/delete', { ids: ids.slice(0, 1000).map((i) => i + 1_000_000) })).status, 404);
  });
});
