import crypto from 'node:crypto';
import type { Request } from 'express';
import type { UserRow } from '../db.ts';

export const COOKIE = 'pinnery_session';
export const SESSION_DAYS = 30;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_ATTEMPTS = 10;
export const MIN_PASSWORD = 8;
export const HOUR_MS = 60 * 60 * 1000;
// How stale a session's last_used_at may get before a request refreshes it, so browsing a board
// isn't one database write per thumbnail.
export const TOUCH_INTERVAL_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();
export const hex = (buf: Uint8Array) => Buffer.from(buf).toString('hex');
export const b64url = (buf: Uint8Array) => Buffer.from(buf).toString('base64url');

// Constant-time string compare. Hashing first makes the lengths equal, so no length leak either.
export function safeEqual(a: string, b: string) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

// Cookies whose value isn't valid percent-encoding are skipped, not fatal: other apps on a parent
// domain can set cookies we receive but don't control (e.g. `other=100%`).
export function parseCookies(header: string | undefined) {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ }
  }
  return out;
}

// A same-origin path for the login page's `next` parameter, or null (home page). Resolved the way a
// browser would, then checked to stay on our origin: a pattern check alone misses tricks like
// "/\t/evil.com", which browsers read as //evil.com. Returns the normalised path, refusing one that
// starts with // (from "/..//evil.com"): that would be read as another host when used again.
// Unparseable values (e.g. "//[") are refused too. Mirrored in public/js/next.ts.
export function safeNext(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('/') || v.length > 2048) return null;
  const base = 'http://pinnery.invalid';
  let u: URL;
  try { u = new URL(v, base); } catch { return null; }
  if (u.origin !== base) return null;
  const path = u.pathname + u.search + u.hash;
  return path.startsWith('//') ? null : path;
}

// The base of links we hand out: PINNERY_PUBLIC_URL when set, else our own origin as the browser
// sees it (X-Forwarded-Proto counts from a proxy, see PINNERY_PROXIES). No trailing slash.
export function linkBase(req: Request, publicUrl = ''): string {
  let base = publicUrl || `${req.protocol}://${req.get('host')}`;
  while (base.endsWith('/')) base = base.slice(0, -1); // not a regex: the Host header is untrusted
  return base;
}

// Whether a request came from one of our own pages, by the browser's word: Sec-Fetch-Site when
// sent, else an Origin matching our own (linkBase, so X-Forwarded-Proto counts behind a proxy).
// A request with neither isn't trusted: every current browser sends at least one on a POST.
export function sameOrigin(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = req.get('origin');
  return !!origin && origin === linkBase(req);
}

// Salted scrypt, stored as salt:hash. Users carry their own; the `password_hash` setting
// remembers PINNERY_PASSWORD so a changed value can be noticed on restart (see seed.ts).
// Requests use the async pair, which runs scrypt on libuv's thread pool instead of the event loop.
const scrypt = (pw: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  crypto.scrypt(pw, salt, 32, (err, key) => (err ? reject(err) : resolve(key)));
});
export const hashPassword = async (pw: string) => {
  const salt = hex(crypto.randomBytes(16));
  return `${salt}:${hex(await scrypt(pw, salt))}`;
};
export const verifyHash = async (pw: string, stored: string | null) => {
  const [salt, digest] = stored ? stored.split(':') : [];
  return !!(salt && digest) && safeEqual(hex(await scrypt(pw, salt)), digest);
};
// Blocking versions, for startup only (seed.ts runs before the server listens).
export const hashPasswordSync = (pw: string) => {
  const salt = hex(crypto.randomBytes(16));
  return `${salt}:${hex(crypto.scryptSync(pw, salt, 32))}`;
};
export const verifyHashSync = (pw: string, stored: string | null) => {
  const [salt, digest] = stored ? stored.split(':') : [];
  return !!(salt && digest) && safeEqual(hex(crypto.scryptSync(pw, salt, 32)), digest);
};
export const normaliseEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
export const validEmail = (e: string) => e.length <= 254 && EMAIL_RE.test(e); // length first: bounds the regex's work

export type LinkKind = 'invite' | 'reset' | 'email_change';

// The user as the API shows them: flags as booleans, no password hash.
export interface PublicUser {
  id: number;
  email: string;
  display_name: string;
  is_admin: boolean;
  must_change_password: boolean;
}

// The caller's browser session or API token, as requireApi/requirePage resolve it.
export interface Session {
  id: number;
  kind: 'session' | 'token';
  token: string;
  user: PublicUser;
}

export type AuthUserRow = Pick<UserRow, 'id' | 'email' | 'display_name' | 'password_hash' | 'is_admin' | 'must_change_password'>;

export const publicUser = (u: Pick<UserRow, 'id' | 'email' | 'display_name' | 'is_admin' | 'must_change_password'>): PublicUser => ({ id: u.id, email: u.email, display_name: u.display_name, is_admin: !!u.is_admin, must_change_password: !!u.must_change_password });
