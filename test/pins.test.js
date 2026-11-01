import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startServer } from './helpers/server.js';
import { jpegBuffer, pngBuffer } from './helpers/images.js';
import { createZipWriter } from '../src/zip.js';

const upload = (client, boardId, buf, query = '') =>
  client.json(`/api/pins/upload?board_id=${boardId}${query}`, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } });
const rawPost = (client, p, buf) => client.json(p, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } });
const newBoard = async (client, name) => (await client.post('/api/boards', { name })).body;
const originalFile = (server, sha) => path.join(server.dataDir, 'originals', sha.slice(0, 2), sha);
const tok = (pick) => pick.token;

// Build a zip in memory with the app's own writer.
async function makeZip(entries) {
  const chunks = [];
  const sink = { write: (b) => { chunks.push(Buffer.from(b)); return true; }, on() {}, off() {} };
  const z = createZipWriter(sink);
  for (const [name, data] of entries) await z.add(name, Buffer.from(data));
  await z.end();
  return Buffer.concat(chunks);
}
const manifest = (boards) => JSON.stringify({ version: 1, exported_at: new Date().toISOString(), boards });

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

  it('serves originals and thumbnails only to people who can see the pin', async () => {
    const buf = await pngBuffer({ width: 900, height: 600, color: '#123456' });
    const { body: pin } = await upload(alice, board.id, buf);
    const orig = await alice.fetch(`/i/${pin.sha256}`);
    assert.equal(orig.status, 200);
    assert.equal(orig.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await orig.arrayBuffer()), buf);

    for (const size of [400, 800]) {
      const t = await alice.fetch(`/t/${size}/${pin.sha256}`);
      assert.equal(t.status, 200);
      assert.equal(t.headers.get('content-type'), 'image/webp');
    }
    assert.equal((await alice.fetch(`/t/123/${pin.sha256}`)).status, 404);
    assert.equal((await alice.fetch(`/i/${'0'.repeat(64)}`)).status, 404);
    assert.equal((await alice.fetch('/i/not-a-sha')).status, 404);

    assert.equal((await bob.fetch(`/i/${pin.sha256}`)).status, 404);
    assert.equal((await bob.fetch(`/t/400/${pin.sha256}`)).status, 404);
    assert.equal((await bob.get(`/api/pins/${pin.id}`)).status, 404);
    assert.notEqual((await server.anon().fetch(`/i/${pin.sha256}`)).status, 200);
  });

  it('shares one original between identical pins and removes it with the last one', async () => {
    const other = await newBoard(alice, 'Second');
    const buf = await pngBuffer({ width: 24, height: 24, color: '#abcdef' });
    const a = (await upload(alice, board.id, buf)).body;
    const b = (await upload(alice, other.id, buf)).body;
    assert.notEqual(a.id, b.id);
    assert.equal(a.sha256, b.sha256);
    const file = originalFile(server, a.sha256);
    assert.ok(fs.existsSync(file));
    assert.equal(fs.readdirSync(path.dirname(file)).filter((n) => n === a.sha256).length, 1);

    assert.equal((await alice.del(`/api/pins/${a.id}`)).status, 200);
    assert.equal((await alice.get(`/api/pins/${a.id}`)).status, 404);
    assert.ok(fs.existsSync(file), 'still referenced by the second pin');
    assert.equal((await alice.fetch(`/i/${b.sha256}`)).status, 200);

    assert.equal((await alice.del(`/api/pins/${b.id}`)).status, 200);
    assert.ok(!fs.existsSync(file), 'last reference gone');
    assert.equal((await alice.fetch(`/i/${b.sha256}`)).status, 404);
    assert.equal((await alice.del(`/api/pins/${b.id}`)).status, 404);
  });

  it('keeps a file shared across users until both have deleted', async () => {
    const buf = await pngBuffer({ width: 12, height: 12, color: '#445566' });
    const bobBoard = await newBoard(bob, 'Bob board');
    const a = (await upload(alice, board.id, buf)).body;
    const b = (await upload(bob, bobBoard.id, buf)).body;
    await alice.del(`/api/pins/${a.id}`);
    assert.equal((await bob.fetch(`/i/${b.sha256}`)).status, 200);
    assert.equal((await alice.fetch(`/i/${b.sha256}`)).status, 404);
    await bob.del(`/api/pins/${b.id}`);
    assert.ok(!fs.existsSync(originalFile(server, a.sha256)));
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

// A tiny upstream serving a PNG, a text file, a redirect and a 404.
async function startUpstream(png) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/img.png') res.writeHead(200, { 'content-type': 'image/png' }).end(png);
    else if (req.url === '/redirect') res.writeHead(302, { location: '/img.png' }).end();
    else if (req.url === '/text') res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
    else res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

describe('pins by URL', () => {
  let png, upstream, locked, open, lockedUser, openUser;
  before(async () => {
    png = await pngBuffer({ width: 40, height: 30, color: '#808000' });
    upstream = await startUpstream(png);
    locked = await startServer();
    open = await startServer({ env: { PINNERY_FETCH_ALLOW: '127.0.0.1/32' } });
    lockedUser = await locked.createUser('u@example.com', 'user-password-1');
    openUser = await open.createUser('u@example.com', 'user-password-1');
  });
  after(async () => { await upstream.close(); await locked.stop(); await open.stop(); });

  const base = () => `http://127.0.0.1:${upstream.port}`;

  it('blocks loopback by default (SSRF guard), for pins and picks', async () => {
    const b = await newBoard(lockedUser, 'B');
    const r = await lockedUser.post('/api/pins/url', { board_id: b.id, url: `${base()}/img.png` });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /blocked/);
    assert.equal((await lockedUser.post('/api/pick/url', { url: `${base()}/img.png` })).status, 400);
    assert.equal((await lockedUser.get(`/api/boards/${b.id}/pins`)).body.pins.length, 0);
  });

  it('validates the request before fetching', async () => {
    const b = await newBoard(lockedUser, 'V');
    assert.equal((await lockedUser.post('/api/pins/url', { url: 'https://example.com/a.png' })).status, 400);
    assert.equal((await lockedUser.post('/api/pins/url', { board_id: b.id })).status, 400);
    assert.equal((await lockedUser.post('/api/pins/url', { board_id: b.id, url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await lockedUser.post('/api/pins/url', { board_id: b.id, url: 'not a url' })).status, 400);
    assert.equal((await lockedUser.post('/api/pins/url', { board_id: 999999, url: 'https://example.com/a.png' })).status, 404);
  });

  it('fetches and pins when the address is allow-listed', async () => {
    const b = await newBoard(openUser, 'Fetched');
    const r = await openUser.post('/api/pins/url', { board_id: b.id, url: `${base()}/img.png`, page_title: 'From URL' });
    assert.equal(r.status, 201);
    assert.equal(r.body.mime, 'image/png');
    assert.equal(r.body.width, 40);
    assert.equal(r.body.source_url, `${base()}/img.png`);
    assert.equal(r.body.page_title, 'From URL');
    const orig = await openUser.fetch(`/i/${r.body.sha256}`);
    assert.deepEqual(Buffer.from(await orig.arrayBuffer()), png);

    const viaRedirect = await openUser.post('/api/pins/url', { board_id: b.id, url: `${base()}/redirect`, source_url: 'https://example.com/page' });
    assert.equal(viaRedirect.status, 201);
    assert.equal(viaRedirect.body.source_url, 'https://example.com/page');
  });

  it('maps upstream failures and non-images to errors', async () => {
    const b = await newBoard(openUser, 'Bad');
    assert.equal((await openUser.post('/api/pins/url', { board_id: b.id, url: `${base()}/text` })).status, 415);
    assert.equal((await openUser.post('/api/pins/url', { board_id: b.id, url: `${base()}/missing` })).status, 502);
  });

  it('picks by URL work too when allowed', async () => {
    const r = await openUser.post('/api/pick/url', { url: `${base()}/img.png` });
    assert.equal(r.status, 201);
    assert.match(r.body.token, /^[0-9a-f]{32}$/);
  });
});

describe('picks', () => {
  let server, alice, bob, boardA;
  before(async () => {
    server = await startServer();
    alice = await server.createUser('alice@example.com', 'alice-password-1');
    bob = await server.createUser('bob@example.com', 'bob-password-1');
    boardA = await newBoard(alice, 'Pick target');
  });
  after(() => server.stop());

  const park = async (client, color) => (await rawPost(client, '/api/pick/upload?source_url=https%3A%2F%2Fexample.com%2Fx&page_title=Parked', await pngBuffer({ width: 50, height: 50, color }))).body;

  it('parks an upload, lets the token alone pick a board and create the pin', async () => {
    const buf = await pngBuffer({ width: 50, height: 25, color: '#0a0b0c' });
    const parked = await rawPost(alice, '/api/pick/upload?source_url=https%3A%2F%2Fexample.com%2Fx&page_title=Parked', buf);
    assert.equal(parked.status, 201);
    const t = tok(parked.body);
    assert.match(t, /^[0-9a-f]{32}$/);

    const anon = server.anon();
    const page = await anon.fetch(`/pick/${t}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');

    const info = (await anon.get(`/pick/${t}/info`)).body;
    assert.equal(info.item.width, 50);
    assert.equal(info.item.mime, 'image/png');
    assert.equal(info.item.page_title, 'Parked');
    assert.deepEqual(info.boards.map((b) => b.name), ['Pick target']);
    assert.equal((await anon.fetch(`/pick/${t}/preview`)).headers.get('content-type'), 'image/webp');

    // Creating a board from the picker works, and shows up in the list.
    const nb = await anon.post(`/pick/${t}/boards`, { name: 'Fresh' });
    assert.equal(nb.status, 201);
    assert.equal((await anon.post(`/pick/${t}/boards`, { name: '  ' })).status, 400);

    const commit = await anon.post(`/pick/${t}/commit`, { board_id: boardA.id });
    assert.equal(commit.status, 201);
    assert.equal(commit.body.board.id, boardA.id);
    assert.equal(commit.body.pin.source_url, 'https://example.com/x');
    assert.equal((await alice.get(`/api/pins/${commit.body.pin.id}`)).body.page_title, 'Parked');
    assert.equal((await alice.fetch(`/i/${commit.body.pin.sha256}`)).status, 200);

    // single use
    assert.equal((await anon.get(`/pick/${t}/info`)).status, 410);
    assert.equal((await anon.post(`/pick/${t}/commit`, { board_id: boardA.id })).status, 410);
    assert.equal((await alice.get(`/api/boards/${boardA.id}/pins`)).body.pins.length, 1);
  });

  it('refuses unknown and malformed tokens', async () => {
    const anon = server.anon();
    assert.equal((await anon.get(`/pick/${'0'.repeat(32)}/info`)).status, 410);
    assert.equal((await anon.post(`/pick/${'0'.repeat(32)}/commit`, { board_id: boardA.id })).status, 410);
    assert.equal((await anon.fetch('/pick/nope')).status, 404);
    assert.equal((await anon.fetch('/pick/nope/info')).status, 404);
    // a well-formed but unknown token still gets the page, which shows the "expired" notice
    assert.equal((await anon.fetch(`/pick/${'0'.repeat(32)}`)).status, 200);
  });

  it('cannot commit to a board the picker\'s user cannot edit, and keeps the token', async () => {
    const t = tok(await park(bob, '#0c0b0a'));
    const anon = server.anon();
    assert.equal((await anon.post(`/pick/${t}/commit`, { board_id: boardA.id })).status, 404);
    assert.equal((await anon.post(`/pick/${t}/commit`, {})).status, 404);
    assert.equal((await anon.get(`/pick/${t}/info`)).status, 200);
    // and bob's picker doesn't list alice's boards
    assert.ok(!(await anon.get(`/pick/${t}/boards`)).body.some((b) => b.name === 'Pick target'));
  });

  it('discard consumes the token without creating a pin', async () => {
    const before = (await alice.get(`/api/boards/${boardA.id}/pins`)).body.pins.length;
    const t = tok(await park(alice, '#aa00aa'));
    const anon = server.anon();
    assert.equal((await anon.post(`/pick/${t}/discard`)).status, 200);
    assert.equal((await anon.get(`/pick/${t}/info`)).status, 410);
    assert.equal((await alice.get(`/api/boards/${boardA.id}/pins`)).body.pins.length, before);
  });

  it('requires auth and a real image to park', async () => {
    assert.equal((await rawPost(server.anon(), '/api/pick/upload', await pngBuffer())).status, 401);
    assert.equal((await rawPost(alice, '/api/pick/upload', Buffer.from('nope'))).status, 415);
    assert.equal((await rawPost(alice, '/api/pick/upload', Buffer.alloc(0))).status, 400);
    assert.equal((await alice.post('/api/pick/url', {})).status, 400);
  });
});

describe('export and import', () => {
  let server, alice, bob, carol;
  const pinned = {};
  before(async () => {
    server = await startServer();
    alice = await server.createUser('alice@example.com', 'alice-password-1');
    bob = await server.createUser('bob@example.com', 'bob-password-1');
    carol = await server.createUser('carol@example.com', 'carol-password-1');

    const cats = await newBoard(alice, 'Cats / Dogs');
    const empty = await newBoard(alice, 'Empty');
    pinned.cats = cats;
    pinned.red = (await upload(alice, cats.id, await pngBuffer({ color: '#ff0000' }), '&name=Red&source_url=https%3A%2F%2Fexample.com%2Fred')).body;
    pinned.green = (await upload(alice, cats.id, await jpegBuffer({ color: '#00ff00' }), '&name=Green')).body;
    await alice.patch(`/api/boards/${cats.id}`, { cover_pin_id: pinned.green.id });
    pinned.empty = empty;
  });
  after(() => server.stop());

  const exportZip = async (client, query = '') => {
    const res = await client.fetch(`/api/export${query}`);
    return { res, buf: Buffer.from(await res.arrayBuffer()) };
  };
  const importZip = (client, buf) => client.json('/api/import', { method: 'POST', body: buf, headers: { 'content-type': 'application/zip' } });

  it('exports a zip and imports it into another account, round-tripping everything', async () => {
    const { res, buf } = await exportZip(alice);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition'), /attachment; filename="pinnery-export-\d{4}-\d{2}-\d{2}\.zip"/);
    assert.deepEqual([...buf.subarray(0, 2)], [0x50, 0x4b]);
    assert.ok(buf.includes(Buffer.from('pins.json')));

    const imp = await importZip(bob, buf);
    assert.equal(imp.status, 200);
    assert.deepEqual(imp.body, { boards_created: 2, boards_merged: 0, pins_added: 2, pins_skipped: 0 });

    const boards = (await bob.get('/api/boards')).body;
    assert.deepEqual(boards.map((b) => b.name).sort(), ['Cats / Dogs', 'Empty']);
    const cats = boards.find((b) => b.name === 'Cats / Dogs');
    assert.equal(cats.pin_count, 2);
    const { pins } = (await bob.get(`/api/boards/${cats.id}/pins?order=asc`)).body;
    const red = pins.find((p) => p.sha256 === pinned.red.sha256);
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
    assert.ok(!pins.some((p) => p.id === pinned.red.id));
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
    assert.match(res.headers.get('content-disposition'), /pinnery-Cats _ Dogs-/);
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
