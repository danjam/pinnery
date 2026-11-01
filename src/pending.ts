// Uploads the server has seen but not saved: picks from the extension and the Android share
// target, parked board-less while the board is chosen on the /pick page (the token doubles as
// that page's credential). Memory only, bounded by time and total size; a lost entry just means
// the image is sent again. When the total is over, a new upload pushes out the same user's older
// ones first, then the oldest of whoever holds the most: a user filling the store expires their
// own picks, not someone else's.

import crypto from 'node:crypto';
import { ImageError } from './images.ts';
import type { Fingerprint } from './images.ts';

// What a pin takes from the page it was saved from.
export interface PinMeta {
  source_url: string | null;
  page_title: string | null;
}

export interface PendingEntry {
  buf: Buffer;
  info: Fingerprint;
  meta: PinMeta;
  userId: number;
  expires: number;
}

export type Pending = ReturnType<typeof createPending>;

export function createPending({ ttlMs = 10 * 60 * 1000, maxBytes = 256 * 1024 * 1024 }: { ttlMs?: number; maxBytes?: number } = {}) {
  const entries = new Map<string, PendingEntry>();
  let total = 0;

  function drop(token: string): PendingEntry | null {
    const e = entries.get(token);
    if (!e) return null;
    entries.delete(token);
    total -= e.buf.length;
    return e;
  }

  // Bytes held per user.
  function usage() {
    const by = new Map<number, number>();
    for (const e of entries.values()) by.set(e.userId, (by.get(e.userId) || 0) + e.buf.length);
    return by;
  }

  // Oldest entry (Map keeps insertion order) of `userId`, never `keep`.
  function oldestOf(userId: number, keep: string) {
    for (const [token, e] of entries) if (token !== keep && e.userId === userId) return token;
    return null;
  }

  // Make room for the entry just added under `keep`: expired entries, then the same user's older
  // ones, then the oldest of the biggest holder among the rest. The new entry always fits on its
  // own (put checks), so this ends with it still there.
  function prune(keep: string, userId: number) {
    const now = Date.now();
    for (const [token, e] of entries) if (e.expires <= now && token !== keep) drop(token);
    while (total > maxBytes) {
      let token = oldestOf(userId, keep);
      if (!token) {
        let biggest: number | null = null;
        let most = 0;
        for (const [id, bytes] of usage()) if (id !== userId && bytes > most) { biggest = id; most = bytes; }
        if (biggest === null) break; // unreachable: only the new entry is left, and it fits
        token = oldestOf(biggest, keep);
      }
      drop(token!);
    }
  }

  function put(record: Omit<PendingEntry, 'expires'>): string {
    const size = record.buf.byteLength;
    if (size > maxBytes) throw new ImageError(413, 'upload too large');
    const token = crypto.randomBytes(16).toString('hex');
    total += size;
    entries.set(token, { ...record, expires: Date.now() + ttlMs });
    prune(token, record.userId);
    return token;
  }

  function get(token: string): PendingEntry | null {
    const e = entries.get(token);
    if (e && e.expires <= Date.now()) { drop(token); return null; }
    return e || null;
  }

  // Remove and return the entry, or null if it's unknown or expired.
  const take = (token: string) => (get(token) ? drop(token) : null);

  return { put, get, take, drop };
}
