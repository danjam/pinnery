import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { createLive } from '../src/live.ts';
import type { Live } from '../src/live.ts';
import { listen } from './helpers/events.ts';

// The event streams themselves (src/live.ts): the heartbeat, ending a stream whose session has
// gone, and closing them all at shutdown. In-process, so the heartbeat can be made fast, behind a
// stub that signs each request in with the session named in its query.
describe('live event streams', () => {
  let dataDir: string, db: Db, live: Live, url: string, userId: number;
  let server: ReturnType<express.Express['listen']>;
  const newSession = () => Number(db.prepare("INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)").run(String(Math.random()), userId).lastInsertRowid);
  const client = (sessionId: number) => ({ fetch: (p: string, init?: RequestInit) => fetch(`${url}${p}?session=${sessionId}`, init) });

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnery-test-'));
    db = openDb(dataDir);
    userId = Number(db.prepare("INSERT INTO users (email, display_name, password_hash) VALUES ('a@example.com', 'a', 'x')").run().lastInsertRowid);
    live = createLive(db, { heartbeatMs: 20 });
    const app = express();
    app.get('/api/events', (req, res, next) => {
      const user = { id: userId, email: 'a@example.com', display_name: 'a', is_admin: false, must_change_password: false };
      req.user = user;
      req.session = { id: Number(req.query.session), kind: 'session', token: 'x', user };
      next();
    }, live.handler);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    live.closeAll();
    server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('sends a heartbeat comment while idle', async () => {
    const l = await listen(client(newSession()));
    // One on connecting, then one per 20 ms (given a while: timers run late on a busy machine).
    for (let i = 0; i < 200 && l.comments() < 3; i++) await new Promise((r) => setTimeout(r, 10));
    l.close();
    assert.ok(l.comments() >= 3, `only ${l.comments()} comments`);
    assert.deepEqual(l.seen, []);
  });

  it('forgets a stream when its client goes away', async () => {
    const l = await listen(client(newSession()));
    assert.ok(live.users().has(userId));
    l.close();
    for (let i = 0; i < 50 && live.users().size; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(live.users().size, 0);
  });

  it('ends a stream at the next heartbeat once its session is gone', async () => {
    const session = newSession();
    const l = await listen(client(session));
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session);
    await l.ended();
  });

  it('sends a ping only to the users named', async () => {
    const l = await listen(client(newSession()));
    live.send([userId + 1], [{ type: 'boards' }]);
    live.send([], [{ type: 'boards' }]);
    live.send([userId], [{ type: 'board', id: 7 }, { type: 'boards' }]);
    await l.next((e) => e.type === 'boards', { since: 0 });
    assert.deepEqual(l.seen, [{ type: 'board', id: 7 }, { type: 'boards' }]);
    l.close();
  });

  it('ends every stream on shutdown', async () => {
    const a = await listen(client(newSession()));
    const b = await listen(client(newSession()));
    live.closeAll();
    await Promise.all([a.ended(), b.ended()]);
  });
});
