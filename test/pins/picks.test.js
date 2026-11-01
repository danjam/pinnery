import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { pngBuffer } from '../helpers/images.js';
import { newBoard, rawPost } from '../helpers/pins.js';

const tok = (pick) => pick.token;

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
