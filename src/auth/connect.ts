import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Core } from './core.ts';
import { b64url, hex, safeEqual, sameOrigin, sha256 } from './util.ts';

const CODE_TTL_MS = 60 * 1000;

// The extension's connect flow (OAuth-style authorization code + PKCE, see createConnect below). The
// redirect may only go back to a Chrome extension's identity page: https://<32 a-p letters>.chromiumapp.org/
const REDIRECT_HOST_RE = /^[a-p]{32}\.chromiumapp\.org$/;
const REDIRECT_PATH_RE = /^\/[A-Za-z0-9._~/-]*$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;       // base64url(SHA-256), unpadded
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;  // RFC 7636 unreserved characters
const STATE_RE = /^[A-Za-z0-9._~-]{1,256}$/;

interface ConnectCode {
  challenge: string;
  redirectUri: string;
  name: string;
  userId: number;
  expires: number;
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

// ---- connect: the extension's token via the site -----------------------------------------
// An OAuth-style authorization code grant with PKCE. The extension opens GET /connect (signed in
// with the normal web session, via /login?next= if needed) and the page asks "Connect <name>?".
// Allow mints a short-lived single-use code bound to the PKCE challenge, redirect URI and name,
// and the page navigates to <redirect_uri>?code=&state= — Chrome hands that back to the extension,
// which exchanges it at POST /api/connect/token with its code_verifier. Codes live in memory only.
export function createConnect({ exchangeFailures, changeRequired, identify, mintToken }: Core) {
  const codes = new Map<string, ConnectCode>();

  function issueCode(params: Omit<ConnectCode, 'expires'>) {
    const now = Date.now();
    for (const [c, e] of codes) if (e.expires <= now) codes.delete(c);
    const code = hex(crypto.randomBytes(32));
    codes.set(code, { ...params, expires: now + CODE_TTL_MS });
    return code;
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

  return { connectDecide, exchangeCode };
}
