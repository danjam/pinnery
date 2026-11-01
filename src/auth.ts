import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getSetting, setSetting } from './db.ts';
import { errorMessage } from './errors.ts';
import type { Db, UserRow } from './db.ts';
import { message } from './mail.ts';
import type { MailMessage, Mailer } from './mail.ts';

const COOKIE = 'pinnery_session';
const SESSION_DAYS = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const MIN_PASSWORD = 8;
const CODE_TTL_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Emailed links (see email_tokens in db.ts): how long each kind lives.
const TTL_MS: Record<LinkKind, number> = { invite: 24 * HOUR_MS, reset: HOUR_MS, email_change: 24 * HOUR_MS };
const TOKEN_RE = /^[0-9a-f]{64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The extension's connect flow (OAuth-style authorization code + PKCE, see connect below). The
// redirect may only go back to a Chrome extension's identity page: https://<32 a-p letters>.chromiumapp.org/
const REDIRECT_HOST_RE = /^[a-p]{32}\.chromiumapp\.org$/;
const REDIRECT_PATH_RE = /^\/[A-Za-z0-9._~/-]*$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;       // base64url(SHA-256), unpadded
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;  // RFC 7636 unreserved characters
const STATE_RE = /^[A-Za-z0-9._~-]{1,256}$/;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();
const hex = (buf: Uint8Array) => Buffer.from(buf).toString('hex');
const b64url = (buf: Uint8Array) => Buffer.from(buf).toString('base64url');

// Constant-time string compare. Hashing first makes the lengths equal, so no length leak either.
function safeEqual(a: string, b: string) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function parseCookies(header: string | undefined) {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
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

// Validate the connect request parameters (query on GET /connect, JSON body on the decision POST).
// Returns { redirectUri, challenge, state, name } or { error }.
export type ConnectParams =
  | { error: string }
  | { error?: undefined; redirectUri: string; challenge: string; state: string; name: string };

export function parseConnectParams(src: Record<string, unknown> | null | undefined): ConnectParams {
  const str = (k: string) => { const v = src?.[k]; return typeof v === 'string' ? v : ''; };
  let redirectUri: string;
  try {
    const u = new URL(str('redirect_uri'));
    const ok = u.protocol === 'https:' && REDIRECT_HOST_RE.test(u.hostname) && REDIRECT_PATH_RE.test(u.pathname)
      && !u.port && !u.search && !u.hash && !u.username && !u.password && u.href.length <= 256;
    if (!ok) throw new Error('bad');
    redirectUri = u.href;
  } catch {
    return { error: 'redirect_uri must be a Chrome extension redirect (https://<id>.chromiumapp.org/)' };
  }
  if (str('code_challenge_method') !== 'S256') return { error: 'code_challenge_method must be S256' };
  const challenge = str('code_challenge');
  if (!CHALLENGE_RE.test(challenge)) return { error: 'code_challenge is malformed' };
  const state = str('state');
  if (!STATE_RE.test(state)) return { error: 'state is missing or malformed' };
  const name = str('name').trim().slice(0, 100) || 'Chrome';
  return { redirectUri, challenge, state, name };
}

// The base of links we hand out: PINNERY_PUBLIC_URL when set, else our own origin as the browser
// sees it (X-Forwarded-Proto counts from a proxy, see PINNERY_PROXIES). No trailing slash.
export function linkBase(req: Request, publicUrl = ''): string {
  let base = publicUrl || `${req.protocol}://${req.get('host')}`;
  while (base.endsWith('/')) base = base.slice(0, -1); // not a regex: the Host header is untrusted
  return base;
}

// mailer: see mail.ts (may be disabled). publicUrl: PINNERY_PUBLIC_URL, the base of emailed links;
// without it the request's own origin is used.
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

type AuthUserRow = Pick<UserRow, 'id' | 'email' | 'display_name' | 'password_hash' | 'is_admin' | 'must_change_password'>;
interface LinkRow {
  id: number;
  kind: LinkKind;
  email: string;
  user_id: number;
  expires_at: string;
}
interface TokenRow {
  id: number;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}
interface ConnectCode {
  challenge: string;
  redirectUri: string;
  name: string;
  userId: number;
  expires: number;
}

export interface AuthOptions {
  password?: string;
  adminEmail?: string;
  mailer: Mailer;
  publicUrl?: string;
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(db: Db, { password, adminEmail, mailer, publicUrl = '' }: AuthOptions) {
  if (!password || !adminEmail) throw new Error('PINNERY_ADMIN_EMAIL and PINNERY_PASSWORD are required');

  // Salted scrypt, stored as salt:hash. Users carry their own; the `password_hash` setting
  // remembers PINNERY_PASSWORD so a changed value can be noticed on restart (see below).
  const hashPassword = (pw: string) => {
    const salt = hex(crypto.randomBytes(16));
    return `${salt}:${hex(crypto.scryptSync(pw, salt, 32))}`;
  };
  const verifyHash = (pw: string, stored: string | null) => {
    const [salt, digest] = stored ? stored.split(':') : [];
    return !!(salt && digest) && safeEqual(hex(crypto.scryptSync(pw, salt, 32)), digest);
  };
  const normaliseEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const validEmail = (e: string) => e.length <= 254 && EMAIL_RE.test(e); // length first: bounds the regex's work

  const USER_COLS = 'id, email, display_name, password_hash, is_admin, must_change_password';
  const getUser = db.prepare<[number], AuthUserRow>(`SELECT ${USER_COLS} FROM users WHERE id = ?`);
  const getUserByEmail = db.prepare<[string], AuthUserRow>(`SELECT ${USER_COLS} FROM users WHERE email = ?`);
  const publicUser = (u: Pick<UserRow, 'id' | 'email' | 'display_name' | 'is_admin' | 'must_change_password'>): PublicUser => ({ id: u.id, email: u.email, display_name: u.display_name, is_admin: !!u.is_admin, must_change_password: !!u.must_change_password });

  // ---- the seeded admin -----------------------------------------------------------------------
  // PINNERY_ADMIN_EMAIL + PINNERY_PASSWORD create the first user on first start, remembered by id
  // in `seed_admin_id` so a later email change doesn't matter. The env password is only a
  // bootstrap/recovery secret: the admin has to choose their own before doing anything else.
  // A database from before accounts (db.ts has backed it up and added the owner columns) hands its
  // boards, sessions and tokens to that user, who keeps the sign-in password of the day
  // (`login_hash`); the change is only forced if that was still PINNERY_PASSWORD.
  const seedAdmin = db.transaction(() => {
    const email = normaliseEmail(adminEmail);
    if (!email.includes('@')) throw new Error('PINNERY_ADMIN_EMAIL is not an email address');
    const legacy = getSetting(db, 'login_hash') || getSetting(db, 'password_hash');
    const forced = !legacy || verifyHash(password, legacy);
    const { lastInsertRowid: id } = db.prepare(
      'INSERT INTO users (email, display_name, password_hash, is_admin, must_change_password) VALUES (?, ?, ?, 1, ?)',
    ).run(email, email.split('@')[0], legacy || hashPassword(password), forced ? 1 : 0);
    const boards = db.prepare('UPDATE boards SET owner_id = ? WHERE owner_id IS NULL').run(id).changes;
    const sessions = db.prepare('UPDATE sessions SET user_id = ? WHERE user_id IS NULL').run(id).changes;
    setSetting(db, 'seed_admin_id', id);
    db.prepare("DELETE FROM settings WHERE key = 'login_hash'").run();
    console.log(`accounts: created admin ${email} (id ${id})${legacy
      ? `, moved ${boards} board(s) and ${sessions} session(s)/token(s); password change required: ${forced ? 'yes' : 'no'}` : ''}`);
  });
  if (!getSetting(db, 'seed_admin_id')) seedAdmin();

  // Editing PINNERY_PASSWORD and restarting resets the seeded admin's password to it (the way back
  // in if it's forgotten), forces a change and drops that user's browser sessions. Other users and
  // all API tokens are untouched.
  const stored = getSetting(db, 'password_hash');
  if (!verifyHash(password, stored)) {
    setSetting(db, 'password_hash', hashPassword(password));
    if (stored) {
      const adminId = Number(getSetting(db, 'seed_admin_id'));
      const { changes: reset } = db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), adminId);
      if (!reset) {
        console.warn(`PINNERY_PASSWORD changed, but the seeded admin (user ${adminId}) no longer exists — nothing reset`);
      } else {
        const { changes } = db.prepare("DELETE FROM sessions WHERE kind = 'session' AND user_id = ?").run(adminId);
        console.log(`PINNERY_PASSWORD changed: reset the seeded admin's password, dropped ${changes} session(s)`);
      }
    }
  }

  const insertSession = db.prepare(
    "INSERT INTO sessions (token_hash, user_id, kind, expires_at) VALUES (?, ?, 'session', ?)",
  );
  // API tokens (the extension's credential) share the table: kind = 'token', named, never expire.
  const insertToken = db.prepare("INSERT INTO sessions (token_hash, user_id, kind, name) VALUES (?, ?, 'token', ?)");
  const tokenRow = db.prepare<[number | bigint], TokenRow>('SELECT id, name, created_at, last_used_at FROM sessions WHERE id = ?');
  const listTokenRows = db.prepare<[number], TokenRow>("SELECT id, name, created_at, last_used_at FROM sessions WHERE kind = 'token' AND user_id = ? ORDER BY id");
  const deleteTokenById = db.prepare("DELETE FROM sessions WHERE id = ? AND kind = 'token' AND user_id = ?");
  const findToken = db.prepare<[string], { id: number; kind: 'session' | 'token'; user_id: number } & Omit<AuthUserRow, 'id' | 'password_hash'>>(`
    SELECT s.id, s.kind, u.id AS user_id, u.email, u.display_name, u.is_admin, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
  const touch = db.prepare("UPDATE sessions SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?");
  const deleteToken = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const purgeExpired = db.prepare("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");

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
    touch.run(row.id);
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

  // POST /api/login — body { email, password }.
  function login(req: Request, res: Response) {
    const user = authenticate(req, res);
    if (!user) return;
    startSession(res, user.id);
    res.json({ ok: true });
  }

  // Set a user's password: clears a required change and cancels any outstanding reset links.
  // Browser sessions other than `keepSessionId` are signed out; API tokens stay.
  const setPassword = db.transaction((userId: number, next: string, keepSessionId: number | null) => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(next), userId);
    db.prepare("DELETE FROM email_tokens WHERE kind = 'reset' AND user_id = ?").run(userId);
    db.prepare("DELETE FROM sessions WHERE kind = 'session' AND user_id = ? AND id IS NOT ?").run(userId, keepSessionId ?? null);
  });

  // POST /api/password — body { current, new }, from a signed-in browser (not an API token). Clears
  // a required change. The user's other browser sessions are signed out; this one and their API
  // tokens stay. Wrong current password is 403, not 401: a 401 would read as "signed out".
  function changePassword(req: Request, res: Response) {
    const session = identify(req);
    if (!session || session.kind !== 'session') return res.status(401).json({ error: 'sign in to change the password' });
    const ip = req.ip;
    if (throttled(ip)) return res.status(429).json({ error: 'too many attempts, try again later' });
    const user = getUser.get(session.user.id)!; // the session's user exists: sessions cascade with it
    const current = typeof req.body?.current === 'string' ? req.body.current : '';
    if (!verifyHash(current, user.password_hash)) {
      recordFailure(ip);
      return res.status(403).json({ error: 'wrong password' });
    }
    const next = typeof req.body.new === 'string' ? req.body.new : '';
    if (next.length < MIN_PASSWORD) return res.status(400).json({ error: `new password must be at least ${MIN_PASSWORD} characters` });
    setPassword(user.id, next, session.id);
    notifyPasswordChanged(user, baseUrl(req));
    res.json({ ok: true });
  }

  // ---- emailed links: invites, password resets, email changes ---------------------------------
  // Each is a random token in a URL; only its hash is stored (email_tokens), with a kind, the email
  // it concerns, the user it belongs to and an expiry. Checking one consumes it when it's used.

  const baseUrl = (req: Request) => linkBase(req, publicUrl);
  const insertLink = db.prepare<[string, LinkKind, string, number, string]>('INSERT INTO email_tokens (token_hash, kind, email, user_id, expires_at) VALUES (?, ?, ?, ?, ?)');
  const findLink = db.prepare<[string, LinkKind], LinkRow>('SELECT id, kind, email, user_id, expires_at FROM email_tokens WHERE token_hash = ? AND kind = ?');
  const deleteLink = db.prepare<[number | bigint]>('DELETE FROM email_tokens WHERE id = ?');
  const deleteUserLinks = db.prepare<[LinkKind, number]>('DELETE FROM email_tokens WHERE kind = ? AND user_id = ?');
  // Rows a week past their expiry go; until then an expired link can still be told from a used one.
  const purgeLinks = db.prepare("DELETE FROM email_tokens WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')");
  const live = "expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

  // Make a link of the given kind. Returns { id, token, expires_at }; the caller builds the URL.
  function issueLink(kind: LinkKind, email: string, userId: number) {
    purgeLinks.run();
    const token = hex(crypto.randomBytes(32));
    const expires = new Date(Date.now() + TTL_MS[kind]).toISOString();
    const { lastInsertRowid } = insertLink.run(hex(sha256(token)), kind, email, userId, expires);
    return { id: lastInsertRowid, token, expires_at: expires };
  }

  // Look a presented token up. Returns the row, or null after answering: 404 for unknown/used,
  // 410 for expired. Guesses count against the client's IP.
  function lookupLink(req: Request, res: Response, kind: LinkKind, what: string): LinkRow | null {
    const ip = req.ip;
    if (linkFailures.throttled(ip)) { res.status(429).json({ error: 'too many attempts, try again later' }); return null; }
    const token = req.params.token;
    const row = typeof token === 'string' && TOKEN_RE.test(token) ? findLink.get(hex(sha256(token)), kind) : null;
    if (!row) {
      linkFailures.record(ip);
      res.status(404).json({ error: `This ${what} link isn't valid any more — it may have been used or cancelled.` });
      return null;
    }
    if (row.expires_at <= new Date().toISOString()) {
      res.status(410).json({ error: `This ${what} link has expired.` });
      return null;
    }
    return row;
  }

  // Send in the background and log the outcome; for emails nobody is waiting on.
  const sendQuietly = (to: string, msg: Omit<MailMessage, 'to'>) => mailer.enabled && mailer.send({ to, ...msg }).catch(() => {});

  function notifyPasswordChanged(user: Pick<UserRow, 'email' | 'display_name'>, base: string) {
    sendQuietly(user.email, message({
      subject: 'Your Pinnery password was changed',
      lines: [`Hi ${user.display_name},`, 'Your Pinnery password was changed just now. Your other browsers have been signed out.'],
      link: `${base}/forgot`,
      linkText: 'Reset your password',
      closing: 'If this was you, there’s nothing to do. If it wasn’t, reset your password with the link above (it needs your email address) and tell your Pinnery admin.',
    }));
  }

  // ---- invites (admins) ----
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => (req.user.is_admin ? next() : res.status(403).json({ error: 'admins only' }));
  const pendingInvites = db.prepare<[], { id: number; email: string; created_at: string; expires_at: string }>(`SELECT id, email, created_at, expires_at FROM email_tokens WHERE kind = 'invite' AND ${live} ORDER BY id`);
  const pendingInviteFor = db.prepare<[string], { id: number }>(`SELECT id FROM email_tokens WHERE kind = 'invite' AND email = ? AND ${live}`);

  // POST /api/invites — body { email }. Emails the signup link when mail is on; the link is in the
  // reply either way (shown once — only its hash is kept), with `sent` and any send error.
  async function createInvite(req: Request, res: Response) {
    const email = normaliseEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'enter an email address' });
    if (getUserByEmail.get(email)) return res.status(409).json({ error: 'That email already has an account.', code: 'has_account' });
    const pending = pendingInviteFor.get(email);
    if (pending) return res.status(409).json({ error: 'That email already has a pending invite.', code: 'pending_invite', invite_id: pending.id });
    const { id, token, expires_at } = issueLink('invite', email, req.user.id);
    const link = `${baseUrl(req)}/signup/${token}`;
    let sent = false, error: string | undefined;
    if (mailer.enabled) {
      try {
        await mailer.send({ to: email, ...message({
          subject: `${req.user.display_name} invited you to Pinnery`,
          lines: [`${req.user.display_name} (${req.user.email}) has invited you to Pinnery, a place to save images into boards.`, 'Choose a name and password to get started. This link works once and expires in 24 hours.'],
          link, linkText: 'Create your account',
          closing: 'If you weren’t expecting this, you can ignore it.',
        }) });
        sent = true;
      } catch (err) {
        error = errorMessage(err);
      }
    }
    res.status(201).json({ id, email, expires_at, link, sent, error });
  }

  function listInvites(req: Request, res: Response) {
    res.json(pendingInvites.all());
  }

  function cancelInvite(req: Request, res: Response) {
    const id = Number(req.params.id);
    const { changes } = Number.isInteger(id) && id > 0 ? db.prepare("DELETE FROM email_tokens WHERE id = ? AND kind = 'invite'").run(id) : { changes: 0 };
    if (!changes) return res.status(404).json({ error: 'invite not found' });
    res.json({ ok: true });
  }

  // GET /api/signup/:token — what the signup page needs: the locked email.
  function inviteInfo(req: Request, res: Response) {
    const row = lookupLink(req, res, 'invite', 'invite');
    if (row) res.json({ email: row.email });
  }

  // POST /api/signup/:token — body { display_name, password }. Creates the (non-admin) user,
  // consumes the invite and signs them in.
  function signup(req: Request, res: Response) {
    const row = lookupLink(req, res, 'invite', 'invite');
    if (!row) return;
    const name = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ error: 'display name must be 1–100 characters' });
    const pw = typeof req.body.password === 'string' ? req.body.password : '';
    if (pw.length < MIN_PASSWORD) return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD} characters` });
    const userId = db.transaction(() => {
      if (getUserByEmail.get(row.email)) return null;
      const { lastInsertRowid } = db.prepare('INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)').run(row.email, name, hashPassword(pw));
      deleteLink.run(row.id);
      return lastInsertRowid;
    })();
    if (!userId) return res.status(409).json({ error: 'That email already has an account — sign in instead.' });
    startSession(res, userId);
    res.status(201).json({ ok: true });
  }

  // ---- forgotten password ----
  // Make a reset link for a user, cancelling their older ones. For the forgot flow here and for an
  // admin handing one over by hand. Returns { link, expires_at }.
  function createResetLink(userId: number, base: string) {
    const user = getUser.get(userId);
    if (!user) throw new Error('no such user');
    deleteUserLinks.run('reset', userId);
    const { token, expires_at } = issueLink('reset', user.email, userId);
    return { link: `${base}/reset/${token}`, expires_at };
  }

  const resetMessage = (user: Pick<UserRow, 'display_name'>, link: string) => message({
    subject: 'Reset your Pinnery password',
    lines: [`Hi ${user.display_name},`, 'Someone asked to reset the password for this Pinnery account. The link works once and expires in an hour.'],
    link, linkText: 'Choose a new password',
    closing: 'If this wasn’t you, ignore this email — your password hasn’t changed.',
  });

  // POST /api/users/:id/reset (admins, see users.ts) — a reset link for that user, emailed when
  // mail is on and returned either way, like an invite: { email, link, expires_at, sent, error }.
  async function adminResetLink(req: Request, res: Response) {
    const id = Number(req.params.id);
    const user = Number.isInteger(id) && id > 0 ? getUser.get(id) : null;
    if (!user) return res.status(404).json({ error: 'user not found' });
    const { link, expires_at } = createResetLink(user.id, baseUrl(req));
    let sent = false, error: string | undefined;
    if (mailer.enabled) {
      try {
        await mailer.send({ to: user.email, ...resetMessage(user, link) });
        sent = true;
      } catch (err) {
        error = errorMessage(err);
      }
    }
    res.status(201).json({ email: user.email, link, expires_at, sent, error });
  }

  // Self-service password reset by email needs PINNERY_PUBLIC_URL as well as mail: the request comes
  // from someone not signed in, and without a fixed base the link would be built from their Host
  // header, so an attacker could have a real reset email point at their own site. Admins can still
  // hand out reset links (Settings → Users).
  const selfReset = mailer.enabled && !!publicUrl;

  // GET /api/mail — whether email is set up, and whether "forgot password" can email a link (the
  // forgot page and Settings adapt). Public.
  const mailStatus = (req: Request, res: Response) => res.json({ enabled: mailer.enabled, reset: selfReset });

  // POST /api/forgot — body { email }. The reply is the same whether or not the account exists, and
  // the email goes out in the background so the timing is too. Per-IP limit answers 429 before
  // any lookup; past the per-address limit the request is just dropped, with the same reply.
  function forgot(req: Request, res: Response) {
    const ip = req.ip;
    if (forgotByIp.throttled(ip)) return res.status(429).json({ error: 'too many requests, try again later' });
    const email = normaliseEmail(req.body?.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'enter an email address' });
    forgotByIp.record(ip);
    const reply = () => res.json({ ok: true, mail: selfReset });
    if (!selfReset || forgotByEmail.throttled(email)) return reply();
    forgotByEmail.record(email);
    const user = getUserByEmail.get(email);
    if (user) {
      const { link } = createResetLink(user.id, baseUrl(req)); // PINNERY_PUBLIC_URL, see selfReset
      sendQuietly(user.email, resetMessage(user, link));
    }
    reply();
  }

  // GET /api/reset/:token — is the link still good? POST — body { password }: sets it, signs the
  // user's other browsers out, signs this one in, and says how many extension tokens they have so
  // the page can offer to revoke those too (DELETE /api/tokens, now that they're signed in).
  function resetInfo(req: Request, res: Response) {
    const row = lookupLink(req, res, 'reset', 'reset');
    if (row) res.json({ email: row.email });
  }

  function reset(req: Request, res: Response) {
    const row = lookupLink(req, res, 'reset', 'reset');
    if (!row) return;
    const pw = typeof req.body?.password === 'string' ? req.body.password : '';
    if (pw.length < MIN_PASSWORD) return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD} characters` });
    const user = getUser.get(row.user_id);
    if (!user) return res.status(404).json({ error: 'This reset link isn’t valid any more.' });
    setPassword(user.id, pw, null);
    startSession(res, user.id);
    notifyPasswordChanged(user, baseUrl(req));
    const { n } = db.prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'token' AND user_id = ?").get(user.id)!;
    res.json({ ok: true, tokens: n });
  }

  // DELETE /api/tokens — revoke all of the caller's API tokens.
  function revokeAllTokens(req: Request, res: Response) {
    const { changes } = db.prepare("DELETE FROM sessions WHERE kind = 'token' AND user_id = ?").run(req.user.id);
    res.json({ ok: true, revoked: changes });
  }

  // ---- email change ----
  // POST /api/email — body { email, password }, signed in. Sends a confirmation to the new address;
  // nothing changes until it's used. Needs mail: a link to copy would go to the wrong person.
  async function requestEmailChange(req: Request, res: Response) {
    if (!mailer.enabled) return res.status(409).json({ error: 'Email isn’t set up on this Pinnery, so the address can’t be changed here.' });
    if (req.session.kind !== 'session') return res.status(403).json({ error: 'sign in to change the email' });
    const ip = req.ip;
    if (throttled(ip)) return res.status(429).json({ error: 'too many attempts, try again later' });
    const user = getUser.get(req.user.id)!;
    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!verifyHash(given, user.password_hash)) {
      recordFailure(ip);
      return res.status(403).json({ error: 'wrong password' });
    }
    const email = normaliseEmail(req.body.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'enter an email address' });
    if (email === user.email) return res.status(400).json({ error: 'that’s already your email' });
    if (getUserByEmail.get(email)) return res.status(409).json({ error: 'That email already has an account.' });
    deleteUserLinks.run('email_change', user.id);
    const { id, token } = issueLink('email_change', email, user.id);
    try {
      await mailer.send({ to: email, ...message({
        subject: 'Confirm your new Pinnery email',
        lines: [`Hi ${user.display_name},`, `You asked to change your Pinnery sign-in email from ${user.email} to ${email}. Confirm it with the link below; it works once and expires in 24 hours.`],
        link: `${baseUrl(req)}/confirm-email/${token}`, linkText: 'Confirm this email',
        closing: 'If this wasn’t you, ignore this email — nothing changes until the link is used.',
      }) });
    } catch (err) {
      deleteLink.run(id);
      return res.status(502).json({ error: `${errorMessage(err)}. The address hasn’t changed.` });
    }
    res.json({ ok: true, email });
  }

  // GET /api/confirm-email/:token — what the page shows. POST — makes the change (a GET can't,
  // since mail scanners open links).
  function confirmEmailInfo(req: Request, res: Response) {
    const row = lookupLink(req, res, 'email_change', 'confirmation');
    if (row) res.json({ email: row.email });
  }

  function confirmEmail(req: Request, res: Response) {
    const row = lookupLink(req, res, 'email_change', 'confirmation');
    if (!row) return;
    const ok = db.transaction(() => {
      if (getUserByEmail.get(row.email)) return false;
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(row.email, row.user_id);
      deleteLink.run(row.id);
      return true;
    })();
    if (!ok) return res.status(409).json({ error: 'That email now belongs to another account, so it can’t be used.' });
    res.json({ ok: true, email: row.email });
  }

  // GET /api/me — who's signed in. PATCH /api/me — body { display_name }.
  function me(req: Request, res: Response) {
    res.json(req.user);
  }

  function updateMe(req: Request, res: Response) {
    const name = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ error: 'display name must be 1–100 characters' });
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, req.user.id);
    res.json({ ...req.user, display_name: name });
  }

  function logout(req: Request, res: Response) {
    const session = identify(req);
    if (session) deleteToken.run(hex(sha256(session.token)));
    res.setHeader('Set-Cookie', cookieHeader(res, '', 0));
    res.json({ ok: true });
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

  // POST /api/tokens — body { email, password, name }. Exchanges the credentials for a named API
  // token (scripts and the API; the extension connects through the site instead, see below).
  function createToken(req: Request, res: Response) {
    const user = authenticate(req, res);
    if (!user) return;
    if (user.must_change_password) return changeRequired(res);
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    res.status(201).json(mintToken(user.id, name));
  }

  // ---- connect: the extension's token via the site -----------------------------------------
  // An OAuth-style authorization code grant with PKCE. The extension opens GET /connect (signed in
  // with the normal web session, via /login?next= if needed) and the page asks "Connect <name>?".
  // Allow mints a short-lived single-use code bound to the PKCE challenge, redirect URI and name,
  // and the page navigates to <redirect_uri>?code=&state= — Chrome hands that back to the extension,
  // which exchanges it at POST /api/connect/token with its code_verifier. Codes live in memory only.

  const codes = new Map<string, ConnectCode>();

  function issueCode(params: Omit<ConnectCode, 'expires'>) {
    const now = Date.now();
    for (const [c, e] of codes) if (e.expires <= now) codes.delete(c);
    const code = hex(crypto.randomBytes(32));
    codes.set(code, { ...params, expires: now + CODE_TTL_MS });
    return code;
  }

  const ownOrigin = (req: Request) => linkBase(req);

  // A state-changing request from our own pages only: the session cookie (SameSite=Lax already
  // keeps it off cross-site POSTs) plus the browser's own word on where the request came from.
  function sameOrigin(req: Request) {
    const site = req.get('sec-fetch-site');
    if (site) return site === 'same-origin';
    const origin = req.get('origin');
    return !!origin && origin === ownOrigin(req);
  }

  // POST /connect/decide — body: the connect params plus { allow }. Responds with where to go next.
  function connectDecide(req: Request, res: Response) {
    const session = identify(req);
    if (!session) return res.status(401).json({ error: 'sign in first' });
    if (session.user.must_change_password) return changeRequired(res);
    if (!sameOrigin(req)) return res.status(403).json({ error: 'cross-site request refused' });
    const p = parseConnectParams(req.body);
    if (p.error !== undefined) return res.status(400).json({ error: p.error });
    const to = new URL(p.redirectUri);
    to.searchParams.set('state', p.state);
    if (req.body.allow === true) {
      to.searchParams.set('code', issueCode({ challenge: p.challenge, redirectUri: p.redirectUri, name: p.name, userId: session.user.id }));
    } else {
      to.searchParams.set('error', 'access_denied');
    }
    res.json({ redirect: to.href });
  }

  // POST /api/connect/token — body { code, code_verifier, redirect_uri }, no auth. The code is
  // consumed on first sight, right or wrong; failures have their own throttle, separate from login.
  function exchangeCode(req: Request, res: Response) {
    const ip = req.ip;
    if (exchangeFailures.throttled(ip)) return res.status(429).json({ error: 'too many attempts, try again later' });
    const str = (k: string): string => (typeof req.body?.[k] === 'string' ? req.body[k] : '');
    const code = str('code');
    const entry = /^[0-9a-f]{64}$/.test(code) ? codes.get(code) : null;
    codes.delete(code);
    const verifier = str('code_verifier');
    const ok = entry && entry.expires > Date.now()
      && str('redirect_uri') === entry.redirectUri
      && VERIFIER_RE.test(verifier)
      && safeEqual(b64url(sha256(verifier)), entry.challenge);
    if (!ok) {
      exchangeFailures.record(ip);
      return res.status(400).json({ error: 'invalid or expired code' });
    }
    res.status(201).json(mintToken(entry.userId, entry.name));
  }

  function listTokens(req: Request, res: Response) {
    res.json(listTokenRows.all(req.user.id).map((r) => ({ ...r, current: r.id === req.session.id })));
  }

  function revokeToken(req: Request, res: Response) {
    const id = Number(req.params.id);
    const { changes } = Number.isInteger(id) && id > 0 ? deleteTokenById.run(id, req.user.id) : { changes: 0 };
    if (!changes) return res.status(404).json({ error: 'token not found' });
    res.json({ ok: true });
  }

  // Middleware. While a password change is required (first sign-in, env reset) the app is closed
  // off until it's done: pages go to the change page, the API answers 403 with a code the front
  // end recognises. Only /api/logout and /api/password (which identify for themselves) stay open.
  function requireApi(req: Request, res: Response, next: NextFunction) {
    const session = identify(req);
    if (!session) return res.status(401).json({ error: 'unauthorised' });
    if (session.user.must_change_password) return changeRequired(res);
    req.session = session;
    req.user = session.user;
    next();
  }

  function requirePage(req: Request, res: Response, next: NextFunction) {
    const session = identify(req);
    if (!session) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (session.user.must_change_password) return res.redirect(302, `/password?next=${encodeURIComponent(req.originalUrl)}`);
    req.session = session;
    req.user = session.user;
    next();
  }

  return {
    identify, login, logout, changePassword, me, updateMe, createToken, listTokens, revokeToken, revokeAllTokens,
    connectDecide, exchangeCode, requireApi, requirePage, requireAdmin,
    createInvite, listInvites, cancelInvite, inviteInfo, signup,
    mailStatus, forgot, resetInfo, reset, createResetLink, adminResetLink,
    requestEmailChange, confirmEmailInfo, confirmEmail,
  };
}
