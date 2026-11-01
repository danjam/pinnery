import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tokenFromLink } from './mail.js';

export const BAD_TOKEN = 'f'.repeat(64);

// Make one emailed link already expired (the server only reads the row). Only just: rows more than
// a week past expiry are purged whenever a link is issued, and a purged link answers 404, not 410.
export function expireLink(server, link) {
  const hash = crypto.createHash('sha256').update(tokenFromLink(link)).digest('hex');
  const db = new Database(path.join(server.dataDir, 'pinnery.db'));
  try {
    db.pragma('busy_timeout = 5000');
    const { changes } = db.prepare('UPDATE email_tokens SET expires_at = ? WHERE token_hash = ?').run(new Date(Date.now() - 60_000).toISOString(), hash);
    assert.equal(changes, 1);
  } finally {
    db.close();
  }
}

export const userByEmail = async (admin, email) => (await admin.get('/api/users')).body.find((u) => u.email === email);
