import assert from 'node:assert/strict';
import { startServer } from './server.js';
import { pngBuffer } from './images.js';

export const upload = (client, boardId, buf, query = '') =>
  client.json(`/api/pins/upload?board_id=${boardId}${query}`, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } });

// Starts a server with owner / editor / viewer / other (never shared with), the owner's
// board 'Inspiration' and one pin on it. With { shared: true }, also shares the board
// with viewer (viewer role) and editor (editor role).
export async function setupBoards({ shared = false } = {}) {
  const server = await startServer();
  const owner = await server.createUser('owner@example.com', 'owner-password-1', { displayName: 'Olive Owner' });
  const editor = await server.createUser('editor@example.com', 'editor-password-1', { displayName: 'Edie Editor' });
  const viewer = await server.createUser('viewer@example.com', 'viewer-password-1', { displayName: 'Vic Viewer' });
  const other = await server.createUser('other@example.com', 'other-password-1', { displayName: 'Otto Other' });
  const ids = {};
  for (const [k, c] of Object.entries({ owner, editor, viewer, other })) ids[k] = (await c.get('/api/me')).body.id;

  const board = (await owner.post('/api/boards', { name: 'Inspiration' })).body;
  const res = await upload(owner, board.id, await pngBuffer({ color: '#112233' }), '&name=first');
  assert.equal(res.status, 201);
  const pin = res.body;

  const sharePath = (who) => `/api/boards/${board.id}/shares/${ids[who]}`;

  if (shared) {
    assert.equal((await owner.json(sharePath('viewer'), { method: 'PUT', json: { role: 'viewer' } })).status, 200);
    assert.equal((await owner.json(sharePath('editor'), { method: 'PUT', json: { role: 'editor' } })).status, 200);
  }

  return { server, owner, editor, viewer, other, ids, board, pin, sharePath };
}
