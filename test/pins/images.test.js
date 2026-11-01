import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.js';
import { pngBuffer } from '../helpers/images.js';
import { newBoard, originalFile, upload } from '../helpers/pins.js';

describe('pins', () => {
  let server, alice, bob, board;
  before(async () => {
    server = await startServer();
    alice = await server.createUser('alice@example.com', 'alice-password-1');
    bob = await server.createUser('bob@example.com', 'bob-password-1');
    board = await newBoard(alice, 'Alice board');
  });
  after(() => server.stop());

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
});
