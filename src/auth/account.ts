import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db.ts';
import type { Core } from './core.ts';
import type { Links } from './links.ts';
import { MIN_PASSWORD, hex, sha256 } from './util.ts';

// Signing in and out, the signed-in user, their password and API tokens, and the middleware that
// guards everything else.
export function createAccount(db: Db, core: Core, { baseUrl, notifyPasswordChanged }: Links) {
  const {
    getUser, listTokenRows, deleteTokenById, deleteToken, throttled,
    cookieHeader, authenticate, checkPassword, changeRequired, identify, startSession, setPassword, mintToken,
  } = core;

  // POST /api/login — body { email, password }.
  async function login(req: Request, res: Response) {
    const user = await authenticate(req, res);
    if (!user) return;
    startSession(res, user.id);
    res.json({ ok: true });
  }

  // POST /api/password — body { current, new }, from a signed-in browser (not an API token). Clears
  // a required change. The user's other browser sessions are signed out; this one and their API
  // tokens stay. Wrong current password is 403, not 401: a 401 would read as "signed out".
  async function changePassword(req: Request, res: Response) {
    const session = identify(req);
    if (!session || session.kind !== 'session') return res.status(401).json({ error: 'sign in to change the password' });
    const ip = req.ip;
    if (throttled(ip)) return res.status(429).json({ error: 'too many attempts, try again later' });
    const user = getUser.get(session.user.id)!; // the session's user exists: sessions cascade with it
    const current = typeof req.body?.current === 'string' ? req.body.current : '';
    if (!await checkPassword(ip, current, user.password_hash)) return res.status(403).json({ error: 'wrong password' });
    const next = typeof req.body.new === 'string' ? req.body.new : '';
    if (next.length < MIN_PASSWORD) return res.status(400).json({ error: `new password must be at least ${MIN_PASSWORD} characters` });
    await setPassword(user.id, next, session.id);
    notifyPasswordChanged(user, baseUrl(req));
    res.json({ ok: true });
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

  // POST /api/tokens — body { email, password, name }. Exchanges the credentials for a named API
  // token (scripts and the API; the extension connects through the site instead, see connect.ts).
  async function createToken(req: Request, res: Response) {
    const user = await authenticate(req, res);
    if (!user) return;
    if (user.must_change_password) return changeRequired(res);
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    res.status(201).json(mintToken(user.id, name));
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

  // DELETE /api/tokens — revoke all of the caller's API tokens.
  function revokeAllTokens(req: Request, res: Response) {
    const { changes } = db.prepare("DELETE FROM sessions WHERE kind = 'token' AND user_id = ?").run(req.user.id);
    res.json({ ok: true, revoked: changes });
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

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => (req.user.is_admin ? next() : res.status(403).json({ error: 'admins only' }));

  return {
    identify, login, logout, changePassword, me, updateMe, createToken, listTokens, revokeToken, revokeAllTokens,
    requireApi, requirePage, requireAdmin,
  };
}
