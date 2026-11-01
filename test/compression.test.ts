import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.ts';
import type { Client, Server } from './helpers/server.ts';
import { jpegBuffer, pngBuffer } from './helpers/images.ts';
import { newBoard, upload } from './helpers/pins.ts';

describe('response compression', () => {
  let server: Server;
  let alice: Client;
  let boardId: number;
  let photo: string;
  before(async () => {
    server = await startServer();
    alice = await server.createUser('alice@example.com', 'alice-password-1');
    boardId = (await newBoard(alice, 'Compressed')).id;
    // Enough pins that the JSON clears compression's 1 KB threshold.
    for (let i = 0; i < 8; i++) assert.equal((await upload(alice, boardId, await pngBuffer({ color: `#3${i}3${i}3${i}`}))).status, 201);
    // An image big enough to clear the threshold too, so only its type keeps it uncompressed.
    const big = await jpegBuffer({ width: 1200, height: 900 });
    assert.ok(big.length > 1024);
    photo = (await upload(alice, boardId, big)).body.sha256;
  });
  after(() => server.stop());

  it('brotli-compresses the board pins JSON', async () => {
    const res = await alice.fetch(`/api/boards/${boardId}/pins`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'br');
    assert.match(res.headers.get('vary') ?? '', /accept-encoding/i);
    const body = await res.json() as { pins: unknown[] };
    assert.equal(body.pins.length, 9);
  });

  it('falls back to gzip', async () => {
    const res = await alice.fetch(`/api/boards/${boardId}/pins`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
  });

  it('leaves images uncompressed', async () => {
    const res = await alice.fetch(`/i/${photo}`, { headers: { 'accept-encoding': 'br, gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), null);
  });
});
