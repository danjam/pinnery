import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { startServer } from '../helpers/server.ts';
import type { Client, Server } from '../helpers/server.ts';

// identify() refreshes a session's last_used_at at most once a minute, not on every request.
describe('session last_used_at throttle', () => {
  let server: Server, erin: Client;
  before(async () => {
    server = await startServer();
    erin = await server.createUser('erin@example.com', 'erin-password-1');
  });
  after(() => server.stop());

  const lastUsed = async (id: number) =>
    (await erin.get('/api/tokens')).body.find((t: { id: number }) => t.id === id).last_used_at as string | null;

  it('writes on first use, skips repeat requests, and refreshes once stale', async () => {
    const token = await erin.mintToken('throttle');
    const id = (await erin.get('/api/tokens')).body.find((t: { name: string }) => t.name === 'throttle').id;
    const api = server.bearer(token);

    assert.equal(await lastUsed(id), null);
    assert.equal((await api.get('/api/me')).status, 200);
    const first = await lastUsed(id);
    assert.ok(first);

    for (let i = 0; i < 3; i++) assert.equal((await api.get('/api/me')).status, 200);
    assert.equal(await lastUsed(id), first);

    // Backdate it past the interval; the next request refreshes it.
    const stale = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const db = new Database(path.join(server.dataDir, 'pinnery.db'));
    try { db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(stale, id); } finally { db.close(); }
    assert.equal(await lastUsed(id), stale);
    assert.equal((await api.get('/api/me')).status, 200);
    const refreshed = await lastUsed(id);
    assert.ok(refreshed && refreshed > first!);
  });
});
