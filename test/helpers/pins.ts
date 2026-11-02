import path from 'node:path';
import Database from 'better-sqlite3';
import type { Client, Server } from './server.ts';

export const upload = (client: Client, boardId: number | string, buf: Buffer, query = '') =>
  client.json(`/api/pins/upload?board_id=${boardId}${query}`, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } });
export const rawPost = (client: Client, p: string, buf: Buffer) => client.json(p, { method: 'POST', body: buf, headers: { 'content-type': 'application/octet-stream' } });
/** The bits of a board the tests lean on (the POST /api/boards reply has more). */
export interface BoardRef {
  id: number;
  name: string;
}
export const newBoard = async (client: Client, name: string): Promise<BoardRef> => (await client.post('/api/boards', { name })).body;
export const originalFile = (server: Pick<Server, 'dataDir'>, sha: string) => path.join(server.dataDir, 'originals', sha.slice(0, 2), sha);

/**
 * Fill a board with `total` pins fast: copies of its uploaded pins, inserted straight into the
 * running server's database and titled "pin <n>" in insert order. They share the originals
 * (deletes keep a file while any pin still uses it).
 */
export function clonePins(server: Pick<Server, 'dataDir'>, boardId: number, total: number) {
  const db = new Database(path.join(server.dataDir, 'pinnery.db'));
  try {
    const base = db.prepare('SELECT sha256, width, height, mime FROM pins WHERE board_id = ? ORDER BY id').all(boardId) as
      { sha256: string; width: number; height: number; mime: string }[];
    const insert = db.prepare('INSERT INTO pins (board_id, sha256, width, height, mime, page_title) VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (let n = base.length; n < total; n++) {
        const b = base[n % base.length];
        insert.run(boardId, b.sha256, b.width, b.height, b.mime, `pin ${n}`);
      }
    })();
  } finally {
    db.close();
  }
}
