import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Db } from '../db.ts';
import {
  COOKIE, HOUR_MS, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, SESSION_DAYS, TOUCH_INTERVAL_MS,
  hashPassword, hex, normaliseEmail, parseCookies, publicUser, sha256, verifyHash,
} from './util.ts';
import type { AuthUserRow, Session } from './util.ts';

interface TokenRow {
  id: number;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}

// Events per key (a client IP, or an email) within a sliding window. Logins, connect-code
// exchanges and emailed-link guesses count separately, so a misbehaving extension can't lock
// the owner out of the web app. Login lockout is per IP, never per account. Keys whose newest
// event has left the window are swept at most once a window, so one-off clients don't stay in
// memory for the life of the process.
export function failureCounter(max = LOGIN_MAX_ATTEMPTS, windowMs = LOGIN_WINDOW_MS) {
  const attempts = new Map<string | undefined, number[]>();
  let lastSweep = Date.now();
  function sweep(now: number) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, list] of attempts) if (now - list[list.length - 1] >= windowMs) attempts.delete(key);
  }
  return {
    throttled(key: string | undefined) {
      const now = Date.now();
      sweep(now);
      const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
      if (list.length) attempts.set(key, list); else attempts.delete(key);
      return list.length >= max;
    },
    record(key: string | undefined) {
      const now = Date.now();
      sweep(now);
      attempts.get(key)?.push(now) ?? attempts.set(key, [now]);
    },
    // Take back one recorded event, for an attempt that was counted up front and then succeeded.
    forgive(key: string | undefined) {
      const list = attempts.get(key);
      list?.pop();
      if (list && !list.length) attempts.delete(key);
    },
    get size() { return attempts.size; },
  };
}

export type Core = ReturnType<typeof createCore>;

// What the auth modules share: user lookups, sessions and tokens, and the failure counters. Made
// once per createAuth, so every module counts against the same budgets.
export function createCore(db: Db) {
  const USER_COLS = 'id, email, display_name, password_hash, is_admin, must_change_password';
  const getUser = db.prepare<[number], AuthUserRow>(`SELECT ${USER_COLS} FROM users WHERE id = ?`);
  const getUserByEmail = db.prepare<[string], AuthUserRow>(`SELECT ${USER_COLS} FROM users WHERE email = ?`);

  const insertSession = db.prepare(
    "INSERT INTO sessions (token_hash, user_id, kind, expires_at) VALUES (?, ?, 'session', ?)",
  );
  // API tokens (the extension's credential) share the table: kind = 'token', named, never expire.
  const insertToken = db.prepare("INSERT INTO sessions (token_hash, user_id, kind, name) VALUES (?, ?, 'token', ?)");
  const tokenRow = db.prepare<[number | bigint], TokenRow>('SELECT id, name, created_at, last_used_at FROM sessions WHERE id = ?');
  const listTokenRows = db.prepare<[number], TokenRow>("SELECT id, name, created_at, last_used_at FROM sessions WHERE kind = 'token' AND user_id = ? ORDER BY id");
  const deleteTokenById = db.prepare("DELETE FROM sessions WHERE id = ? AND kind = 'token' AND user_id = ?");
  const findToken = db.prepare<[string], { id: number; kind: 'session' | 'token'; last_used_at: string | null; user_id: number } & Omit<AuthUserRow, 'id' | 'password_hash'>>(`
    SELECT s.id, s.kind, s.last_used_at, u.id AS user_id, u.email, u.display_name, u.is_admin, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
  const touch = db.prepare("UPDATE sessions SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?");
  const deleteToken = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const purgeExpired = db.prepare("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");

  const loginFailures = failureCounter();
  const exchangeFailures = failureCounter();
  const linkFailures = failureCounter();                   // bad invite/reset/confirm tokens, per IP
  const forgotByIp = failureCounter(5, 15 * 60 * 1000);    // reset requests, per IP
  const forgotByEmail = failureCounter(3, HOUR_MS);        // reset requests, per address
  const throttled = loginFailures.throttled;
  const recordFailure = loginFailures.record;
  const forgiveFailure = loginFailures.forgive;

  // Secure when the request came over HTTPS (directly or via the trusted reverse proxy's
  // X-Forwarded-Proto), so plain-http setups can still sign in.
  function cookieHeader(res: Response, token: string, maxAge: number) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (res.req.secure) parts.push('Secure');
    return parts.join('; ');
  }

  // Hashing against this when the email is unknown keeps the timing the same as a wrong password.
  // Only its salt is used, so it needn't be a real hash.
  const DUMMY_HASH = `${hex(crypto.randomBytes(16))}:${hex(crypto.randomBytes(32))}`;

  // Check the submitted email + password, counting failures per IP (not per account, so nobody can
  // lock another user out). Returns the user row, or null after sending the error — the same one
  // for an unknown email and a wrong password.
  async function authenticate(req: Request, res: Response): Promise<AuthUserRow | null> {
    const ip = req.ip;
    if (throttled(ip)) { res.status(429).json({ error: 'too many attempts, try again later' }); return null; }
    const body = req.body || {};
    const user = getUserByEmail.get(normaliseEmail(body.email));
    const given = typeof body.password === 'string' ? body.password : '';
    if (!await checkPassword(ip, given, user ? user.password_hash : DUMMY_HASH) || !user) {
      res.status(401).json({ error: 'wrong email or password' });
      return null;
    }
    return user;
  }

  // Verify a password against the caller's login budget. The attempt counts before hashing, so
  // concurrent requests from one IP can't all pass throttled() while their hashes run; it's
  // forgiven if the password is right.
  async function checkPassword(ip: string | undefined, given: string, stored: string | null) {
    recordFailure(ip);
    const ok = await verifyHash(given, stored);
    if (ok) forgiveFailure(ip);
    return ok;
  }

  const changeRequired = (res: Response) => res.status(403).json({ error: 'choose a new password first', code: 'password_change_required' });

  // Resolve the caller's session from a bearer token or the cookie. Returns { id, kind, token, user }
  // or null.
  function identify(req: Request): Session | null {
    const auth = req.headers.authorization;
    let token: string | null = null;
    if (auth && auth.startsWith('Bearer ')) token = auth.slice(7).trim();
    else token = parseCookies(req.headers.cookie)[COOKIE] || null;
    if (!token) return null;
    const row = findToken.get(hex(sha256(token)));
    if (!row) return null;
    if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) >= TOUCH_INTERVAL_MS) touch.run(row.id);
    return { id: row.id, kind: row.kind, token, user: publicUser({ ...row, id: row.user_id }) };
  }

  // A new browser session for the user, set as the cookie.
  function startSession(res: Response, userId: number | bigint) {
    purgeExpired.run();
    const token = hex(crypto.randomBytes(32));
    const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
    insertSession.run(hex(sha256(token)), userId, expires);
    res.setHeader('Set-Cookie', cookieHeader(res, token, SESSION_DAYS * 86400));
  }

  // Set a user's password: clears a required change and cancels any outstanding reset links.
  // Browser sessions other than `keepSessionId` are signed out; API tokens stay. With `linkId`, the
  // emailed link that authorised it is claimed in the same transaction: if a concurrent request
  // used it while this one was hashing, nothing changes and it returns false.
  const storePassword = db.transaction((userId: number, hash: string, keepSessionId: number | null, linkId?: number | bigint) => {
    if (linkId !== undefined && !db.prepare('DELETE FROM email_tokens WHERE id = ?').run(linkId).changes) return false;
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, userId);
    db.prepare("DELETE FROM email_tokens WHERE kind = 'reset' AND user_id = ?").run(userId);
    db.prepare("DELETE FROM sessions WHERE kind = 'session' AND user_id = ? AND id IS NOT ?").run(userId, keepSessionId ?? null);
    return true;
  });
  async function setPassword(userId: number, next: string, keepSessionId: number | null, linkId?: number | bigint) {
    return storePassword(userId, await hashPassword(next), keepSessionId, linkId);
  }

  // Create a named API token. Prefixed so a leaked token is recognisable (secret scanners, logs);
  // older unprefixed tokens still work, since only the hash of whatever is presented is compared.
  // The plain token is returned exactly once — only its hash is kept.
  function mintToken(userId: number, name: string) {
    const token = `pn_${hex(crypto.randomBytes(32))}`;
    const { lastInsertRowid } = insertToken.run(hex(sha256(token)), userId, name);
    const row = tokenRow.get(lastInsertRowid)!;
    return { id: row.id, name: row.name, created_at: row.created_at, token };
  }

  return {
    getUser, getUserByEmail, listTokenRows, deleteTokenById, deleteToken,
    exchangeFailures, linkFailures, forgotByIp, forgotByEmail, throttled,
    cookieHeader, authenticate, checkPassword, changeRequired, identify, startSession, setPassword, mintToken,
  };
}
