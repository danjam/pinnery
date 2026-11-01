import path from 'node:path';
import type { Client, Server } from './server.ts';

export const upload = (client: Client, boardId: number | string, buf: Buffer, query = '') =>
  client.json(`/api/pins/upload?board_id=${boardId}${query}`, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } });
export const rawPost = (client: Client, p: string, buf: Buffer) => client.json(p, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } });
export const newBoard = async (client: Client, name: string) => (await client.post('/api/boards', { name })).body;
export const originalFile = (server: Pick<Server, 'dataDir'>, sha: string) => path.join(server.dataDir, 'originals', sha.slice(0, 2), sha);
