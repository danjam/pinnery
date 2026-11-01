import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/server.ts';
import type { Server } from './helpers/server.ts';

// The cap on requests per client IP (server.ts): 1000 a minute. Each test uses its own forwarded IP,
// so they don't share a budget with each other or with the startup checks.
describe('rate limit', () => {
  let server: Server;
  before(async () => { server = await startServer(); });
  after(() => server.stop());

  it('answers 429 past 1000 requests a minute from one IP, and only for that IP', async () => {
    const client = server.anon({ ip: '127.0.0.81' });
    for (let sent = 0; sent < 1000; sent += 100) {
      const statuses = await Promise.all(Array.from({ length: 100 }, () => client.fetch('/healthz').then((r) => r.status)));
      assert.ok(statuses.every((s) => s === 200), `request ${sent + statuses.findIndex((s) => s !== 200) + 1} was refused`);
    }
    const { status, body } = await client.get('/healthz');
    assert.equal(status, 429);
    assert.equal(body.error, 'too many requests, try again shortly');

    assert.equal((await server.anon({ ip: '127.0.0.82' }).get('/healthz')).status, 200);
  });
});
