// Uploads the server has seen but not saved: picks from the extension and the Android share
// target, parked board-less while the board is chosen on the /pick page (the token doubles as
// that page's credential). Memory only, bounded by time and total size; a lost entry just means
// the image is sent again.

import crypto from 'node:crypto';
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

  function prune() {
    const now = Date.now();
    for (const [token, e] of entries) if (e.expires <= now) drop(token);
    // Oldest first (Map keeps insertion order) until the new entry fits.
    for (const token of entries.keys()) {
      if (total <= maxBytes) break;
      drop(token);
    }
  }

  function put(record: Omit<PendingEntry, 'expires'>): string {
    const token = crypto.randomBytes(16).toString('hex');
    total += record.buf.length;
    entries.set(token, { ...record, expires: Date.now() + ttlMs });
    prune();
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
