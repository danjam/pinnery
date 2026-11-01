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
// the owner out of the web app. Login lockout is per IP, never per account.
function failureCounter(max = LOGIN_MAX_ATTEMPTS, windowMs = LOGIN_WINDOW_MS) {
  const attempts = new Map<string | undefined, number[]>();
  return {
    throttled(key: string | undefined) {
      const now = Date.now();
      const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
      if (list.length) attempts.set(key, list); else attempts.delete(key);
      return list.length >= max;
    },
    record(key: string | undefined) {
      attempts.get(key)?.push(Date.now()) ?? attempts.set(key, [Date.now()]);
    },
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

  // Secure when the request came over HTTPS (directly or via the trusted reverse proxy's
  // X-Forwarded-Proto), so plain-http setups can still sign in.
  function cookieHeader(res: Response, token: string, maxAge: number) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (res.req.secure) parts.push('Secure');
    return parts.join('; ');
  }

  // Hashing against this when the email is unknown keeps the timing the same as a wrong password.
  const DUMMY_HASH = hashPassword(hex(crypto.randomBytes(16)));

  // Check the submitted email + password, counting failures per IP (not per account, so nobody can
  // lock another user out). Returns the user row, or null after sending the error — the same one
  // for an unknown email and a wrong password.
  function authenticate(req: Request, res: Response): AuthUserRow | null {
    const ip = req.ip;
    if (throttled(ip)) { res.status(429).json({ error: 'too many attempts, try again later' }); return null; }
    const body = req.body || {};
    const user = getUserByEmail.get(normaliseEmail(body.email));
    const given = typeof body.password === 'string' ? body.password : '';
    if (!verifyHash(given, user ? user.password_hash : DUMMY_HASH) || !user) {
      recordFailure(ip);
      res.status(401).json({ error: 'wrong email or password' });
      return null;
    }
    return user;
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
  // Browser sessions other than `keepSessionId` are signed out; API tokens stay.
  const setPassword = db.transaction((userId: number, next: string, keepSessionId: number | null) => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(next), userId);
    db.prepare("DELETE FROM email_tokens WHERE kind = 'reset' AND user_id = ?").run(userId);
    db.prepare("DELETE FROM sessions WHERE kind = 'session' AND user_id = ? AND id IS NOT ?").run(userId, keepSessionId ?? null);
  });

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
    exchangeFailures, linkFailures, forgotByIp, forgotByEmail, throttled, recordFailure,
    cookieHeader, authenticate, changeRequired, identify, startSession, setPassword, mintToken,
  };
}
