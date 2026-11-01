import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { openDb } from '../../src/db.ts';
import type { Db, PinRow } from '../../src/db.ts';
import { createStore } from '../../src/images.ts';
import type { Store } from '../../src/images.ts';
import { createRoutes } from '../../src/routes.ts';
import type { Routes } from '../../src/routes.ts';
import { pngBuffer } from '../helpers/images.ts';

// Saves and deletes of pins sharing one original (#85). These need to pause a save part-way, which
// the subprocess harness can't do, so the routes run in-process here, on a store whose thumbnail
// step waits for the test, behind a stub that signs every request in as one user.
describe('saves and deletes sharing an original', () => {
  let dataDir: string, db: Db, store: Store, routes: Routes, url: string, boardId: number;
  let server: ReturnType<express.Express['listen']>;
  // While set, saveThumbs calls `entered` and waits for `release` (or fails if it rejects).
  let gate: { entered: () => void; release: Promise<void> } | null = null;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnery-test-'));
    db = openDb(dataDir);
    store = createStore(dataDir);
    const gated: Store = {
      ...store,
      async saveThumbs(buf, info) {
        if (gate) { gate.entered(); await gate.release; }
        return store.saveThumbs(buf, info);
      },
    };
    const userId = Number(db.prepare("INSERT INTO users (email, display_name, password_hash) VALUES ('a@example.com', 'a', 'x')").run().lastInsertRowid);
    boardId = Number(db.prepare('INSERT INTO boards (name, owner_id) VALUES (?, ?)').run('b', userId).lastInsertRowid);
    routes = createRoutes(db, gated, { dataDir });
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: userId, email: 'a@example.com', display_name: 'a', is_admin: false, must_change_password: false };
      next();
    });
    app.use('/api', routes.api);
    // eslint-disable-next-line no-unused-vars
    app.use((err: Error & { status?: number }, _req: Request, res: ExpressResponse, _next: NextFunction) => {
      res.status(err.status || 500).json({ error: err.message });
    });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const upload = (buf: Buffer) => fetch(`${url}/api/pins/upload?board_id=${boardId}`, { method: 'POST', body: buf });
  const json = async (res: Response | Promise<Response>) => (await (await res).json()) as PinRow;
  const pinCount = (sha: string) => (db.prepare('SELECT COUNT(*) AS n FROM pins WHERE sha256 = ?').get(sha) as { n: number }).n;

  // Close the gate; resolves once a save is waiting at it.
  function closeGate() {
    let release!: () => void, fail!: (e: Error) => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    gate = { entered, release: new Promise<void>((resolve, reject) => { release = resolve; fail = reject; }) };
    gate.release.catch(() => {}); // a rejection is consumed by the save; this just stops an unhandled warning
    return { waiting, open: () => { gate = null; release(); }, fail: (e: Error) => { gate = null; fail(e); } };
  }

  it('a new pin keeps its original when the last other pin with it is deleted mid-save', async () => {
    const buf = await pngBuffer({ color: '#123456' });
    const first = await json(upload(buf));
    const g = closeGate();
    const saving = upload(buf);
    await g.waiting;
    assert.equal((await fetch(`${url}/api/pins/${first.id}`, { method: 'DELETE' })).status, 200);
    g.open();
    const res = await saving;
    assert.equal(res.status, 201);
    const second = await json(res);
    assert.equal(second.sha256, first.sha256);
    assert.ok(store.original(first.sha256), 'original is still there');
    assert.ok(await store.thumb(first.sha256, 400));
  });

  it('a save whose thumbnails fail leaves no pin behind', async () => {
    const buf = await pngBuffer({ color: '#654321' });
    const g = closeGate();
    const saving = upload(buf);
    await g.waiting;
    g.fail(new Error('thumbnail failed'));
    assert.equal((await saving).status, 500);
    const sha = (await store.fingerprint(buf)).sha256;
    assert.equal(pinCount(sha), 0);
    assert.equal(store.original(sha), null);
  });

  it('files stay if the deleting transaction rolls back', async () => {
    const pin = await json(upload(await pngBuffer({ color: '#abcdef' })));
    assert.throws(() => db.transaction(() => {
      routes.deletePinRows([pin.id]);
      throw new Error('rollback');
    })(), /rollback/);
    assert.equal(pinCount(pin.sha256), 1);
    assert.ok(store.original(pin.sha256), 'original is still there');
  });
});
