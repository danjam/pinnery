import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.ts';
import type { Client, Server } from '../helpers/server.ts';
import { jpegBuffer, pngBuffer } from '../helpers/images.ts';
import { newBoard, upload, type BoardRef } from '../helpers/pins.ts';
import { createZipWriter, openZipFile } from '../../src/zip.ts';

// Build a zip in memory with the app's own writer.
async function makeZip(entries: [string, string | Buffer][]) {
  const chunks: Buffer[] = [];
  const sink = { write: (b: Uint8Array) => { chunks.push(Buffer.from(b)); return true; }, on() {}, off() {} };
  const z = createZipWriter(sink);
  for (const [name, data] of entries) await z.add(name, Buffer.from(data));
  await z.end();
  return Buffer.concat(chunks);
}
const manifest = (boards: unknown[]) => JSON.stringify({ version: 1, exported_at: new Date().toISOString(), boards });

// The pins the fixtures upload, as the API reports them.
interface PinRef {
  id: number;
  sha256: string;
}

describe('export and import', () => {
  let server: Server, alice: Client, bob: Client, carol: Client;
  let pinned: { cats: BoardRef; empty: BoardRef; red: PinRef; green: PinRef };
  before(async () => {
    server = await startServer();
    alice = await server.createUser('alice@example.com', 'alice-password-1');
    bob = await server.createUser('bob@example.com', 'bob-password-1');
    carol = await server.createUser('carol@example.com', 'carol-password-1');

    const cats = await newBoard(alice, 'Cats / Dogs');
    const empty = await newBoard(alice, 'Empty');
    const red: PinRef = (await upload(alice, cats.id, await pngBuffer({ color: '#ff0000' }), '&name=Red&source_url=https%3A%2F%2Fexample.com%2Fred')).body;
    const green: PinRef = (await upload(alice, cats.id, await jpegBuffer({ color: '#00ff00' }), '&name=Green')).body;
    await alice.patch(`/api/boards/${cats.id}`, { cover_pin_id: green.id });
    pinned = { cats, empty, red, green };
  });
  after(() => server.stop());

  const exportZip = async (client: Client, query = '') => {
    const res = await client.fetch(`/api/export${query}`);
    return { res, buf: Buffer.from(await res.arrayBuffer()) };
  };
  const importZip = (client: Client, buf: Buffer) => client.json('/api/import', { method: 'POST', body: buf, headers: { 'content-type': 'application/zip' } });

  it('exports a zip and imports it into another account, round-tripping everything', async () => {
    const { res, buf } = await exportZip(alice);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="pinnery-export-\d{4}-\d{2}-\d{2}\.zip"/);
    assert.deepEqual([...buf.subarray(0, 2)], [0x50, 0x4b]);
    assert.ok(buf.includes(Buffer.from('pins.json')));

    const imp = await importZip(bob, buf);
    assert.equal(imp.status, 200);
    assert.deepEqual(imp.body, { boards_created: 2, boards_merged: 0, pins_added: 2, pins_skipped: 0 });

    const boards = (await bob.get('/api/boards')).body;
    assert.deepEqual(boards.map((b: { name: string }) => b.name).sort(), ['Cats / Dogs', 'Empty']);
    const cats = boards.find((b: { name: string }) => b.name === 'Cats / Dogs');
    assert.equal(cats.pin_count, 2);
    const { pins } = (await bob.get(`/api/boards/${cats.id}/pins?order=asc`)).body;
    const red = pins.find((p: { sha256: string }) => p.sha256 === pinned.red.sha256);
    assert.equal(red.page_title, 'Red');
    assert.equal(red.source_url, 'https://example.com/red');
    assert.equal(cats.cover.sha256, pinned.green.sha256, 'cover restored');
    for (const sha of [pinned.red.sha256, pinned.green.sha256]) {
      const a = Buffer.from(await (await alice.fetch(`/i/${sha}`)).arrayBuffer());
      const b = Buffer.from(await (await bob.fetch(`/i/${sha}`)).arrayBuffer());
      assert.deepEqual(b, a);
    }
    // alice's data is untouched, bob's pins are his own rows
    assert.equal((await alice.get('/api/boards')).body.length, 2);
    assert.ok(!pins.some((p: { id: number }) => p.id === pinned.red.id));
  });

  it('importing the same zip again adds nothing (merge by name)', async () => {
    const { buf } = await exportZip(alice);
    const first = await importZip(carol, buf);
    assert.equal(first.body.pins_added, 2);
    const again = await importZip(carol, buf);
    assert.deepEqual(again.body, { boards_created: 0, boards_merged: 2, pins_added: 0, pins_skipped: 2 });
    assert.equal((await carol.get('/api/boards')).body.length, 2);
  });

  it('exports one board with ?board= and only your own', async () => {
    const { res, buf } = await exportZip(alice, `?board=${pinned.cats.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /pinnery-Cats _ Dogs-/);
    const imp = await importZip(await server.createUser('dave@example.com', 'dave-password-1'), buf);
    assert.equal(imp.body.boards_created, 1);
    assert.equal(imp.body.pins_added, 2);

    assert.equal((await bob.fetch(`/api/export?board=${pinned.cats.id}`)).status, 404);
    assert.equal((await alice.fetch('/api/export?board=abc')).status, 404);
    assert.equal((await server.anon().fetch('/api/export')).status, 401);
    assert.equal((await importZip(server.anon(), buf)).status, 401);
  });

  it('imports into a fresh server', async () => {
    const { buf } = await exportZip(alice);
    const fresh = await startServer();
    try {
      const u = await fresh.createUser('new@example.com', 'new-password-1');
      const imp = await importZip(u, buf);
      assert.equal(imp.status, 200);
      assert.equal(imp.body.pins_added, 2);
      assert.equal((await u.fetch(`/i/${pinned.red.sha256}`)).status, 200);
      assert.equal((await u.fetch(`/t/400/${pinned.red.sha256}`)).status, 200);
    } finally {
      await fresh.stop();
    }
  });

  it('rejects malformed zips cleanly and creates nothing', async () => {
    const u = await server.createUser('eve@example.com', 'eve-password-1');
    const png = await pngBuffer({ color: '#101010' });
    const cases = {
      empty: Buffer.alloc(0),
      garbage: Buffer.from('this is not a zip file at all'),
      truncated: (await exportZip(alice)).buf.subarray(0, 40),
      'no manifest': await makeZip([['a.png', png]]),
      'bad json': await makeZip([['pins.json', '{nope']]),
      'wrong version': await makeZip([['pins.json', JSON.stringify({ version: 2, boards: [] })]]),
      'missing file': await makeZip([['pins.json', manifest([{ name: 'B', pins: [{ file: 'B/x.png' }] }])]]),
      'path traversal': await makeZip([['pins.json', manifest([{ name: 'B', pins: [{ file: '../x.png' }] }])], ['../x.png', png]]),
      'not an image': await makeZip([['pins.json', manifest([{ name: 'B', pins: [{ file: 'B/x.png' }] }])], ['B/x.png', 'plain text']]),
    };
    for (const [name, buf] of Object.entries(cases)) {
      const r = await importZip(u, buf);
      assert.ok([400, 415].includes(r.status), `${name}: got ${r.status}`);
      assert.equal(typeof r.body?.error, 'string', name);
    }
    assert.deepEqual((await u.get('/api/boards')).body, [], 'a failed import leaves no empty boards');
    // the server is still fine
    assert.equal((await u.get('/api/me')).status, 200);
  });

  it('a good zip with a valid manifest imports', async () => {
    const u = await server.createUser('frank@example.com', 'frank-password-1');
    const png = await pngBuffer({ color: '#202020' });
    const zip = await makeZip([
      ['pins.json', manifest([{ name: 'Hand made', pins: [{ file: 'Hand made/a.png', page_title: 'T', created_at: '2020-01-02T03:04:05.000Z' }] }])],
      ['Hand made/a.png', png],
    ]);
    const r = await importZip(u, zip);
    assert.equal(r.status, 200);
    const b = (await u.get('/api/boards')).body[0];
    const pin = (await u.get(`/api/boards/${b.id}/pins`)).body.pins[0];
    assert.equal(pin.page_title, 'T');
    assert.equal(pin.created_at, '2020-01-02T03:04:05.000Z');
  });
});

describe('zip reader limits', () => {
  let dir: string;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnery-zip-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, buf: Buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, buf);
    return file;
  };

  it('refuses an entry whose declared compressed size is over the cap, before reading it', async () => {
    const zip = await makeZip([['a.bin', Buffer.alloc(10, 1)], ['pad.bin', crypto.randomBytes(4000)]]);
    // Rewrite a.bin's compressed size in the central directory (offset 20 of its record) to 3000:
    // still inside the file, but over the 1000-byte cap while its declared size stays 10.
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(3000, cd + 20);
    const z = openZipFile(write('compressed.zip', zip), { maxEntrySize: 1000 });
    try {
      const entry = z.entries.find((e) => e.name === 'a.bin')!;
      assert.throws(() => z.read(entry), /a\.bin: too large/);
    } finally {
      z.close();
    }
  });

  it('still reads an incompressible entry at the cap, though deflate made it slightly bigger', async () => {
    const data = crypto.randomBytes(1000);
    const z = openZipFile(write('incompressible.zip', await makeZip([['r.bin', data]])), { maxEntrySize: 1000 });
    try {
      const entry = z.entries[0];
      assert.ok(entry.compressedSize > 1000, `compressed ${entry.compressedSize}`);
      assert.deepEqual(z.read(entry), data);
    } finally {
      z.close();
    }
  });
});
