import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.ts';
import type { MailServer } from '../helpers/server.ts';

describe('share notification (mail on)', () => {
  let server: MailServer;
  before(async () => { server = await startServer({ mail: true }); });
  after(() => server.stop());

  it('names the sharer without giving out their email', async () => {
    const alice = await server.createUser('alice@example.com', 'alice-password-1', { displayName: 'Alice' });
    const bob = await server.createUser('bob@example.com', 'bob-password-1', { displayName: 'Bob' });
    const bobId = (await bob.get('/api/me')).body.id;
    const board = (await alice.post('/api/boards', { name: 'Holiday' })).body;
    server.mail.clear();
    assert.equal((await alice.json(`/api/boards/${board.id}/shares/${bobId}`, { method: 'PUT', json: { role: 'viewer' } })).status, 200);
    const mail = await server.mail.waitFor((m) => m.to.includes('bob@example.com'));
    assert.match(mail.text, /Alice shared the Pinnery board/);
    assert.ok(!mail.text.includes('alice@example.com'), 'the sharer\'s email is not in the notice');
    assert.ok(!mail.html.includes('alice@example.com'));
  });
});
