import path from 'node:path';

export const upload = (client, boardId, buf, query = '') =>
  client.json(`/api/pins/upload?board_id=${boardId}${query}`, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } });
export const rawPost = (client, p, buf) => client.json(p, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } });
export const newBoard = async (client, name) => (await client.post('/api/boards', { name })).body;
export const originalFile = (server, sha) => path.join(server.dataDir, 'originals', sha.slice(0, 2), sha);
