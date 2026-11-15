import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import * as client from 'openid-client';
import type { Db } from '../db.ts';
import type { Core } from './core.ts';
import { hex, normaliseEmail, parseCookies, safeNext } from './util.ts';

// Sign-in with an OpenID Connect provider (single sign-on), alongside passwords. Configured by
// PINNERY_OIDC_ISSUER, PINNERY_OIDC_CLIENT_ID and PINNERY_OIDC_CLIENT_SECRET, and needs
// PINNERY_PUBLIC_URL for the redirect URI. Off when any of those is missing.
//
// Authorization code flow with PKCE, state and nonce. GET /auth/oidc/start puts the checks (state,
// PKCE verifier, nonce, next) in an HttpOnly cookie and sends the browser to the provider; the
// provider sends it back to GET /auth/oidc/callback, where the state must match the cookie's. Kept
// in the browser rather than server memory, so an anonymous client can't fill a shared store and
// lock everyone else out of SSO. The code is single-use at the provider, so a replayed cookie fails.
// openid-client checks the ID token's issuer, audience, expiry and nonce; its signature isn't
// checked, as it comes straight from the token endpoint over TLS (OIDC Core 3.1.3.7).
//
// Accounts are invite-only, so SSO never creates one. A user is found by the provider's subject
// (`users.oidc_sub`) once linked. Until then, the first sign-in links the user whose email matches,
// but only if the provider says the email is verified and the user isn't linked to another subject.
// Passwords keep working, so PINNERY_PASSWORD stays the way back in if the provider is down.
//
// The provider is set by the operator, not a user, so its requests don't go through the SSRF guard
// (fetch.ts): it's usually on a private address the guard would refuse.

export const OIDC_COOKIE = 'pinnery_oidc';
const STATE_TTL_S = 10 * 60;
const SCOPE = 'openid email profile';
export const CALLBACK_PATH = '/auth/oidc/callback';

export interface OidcOptions {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  name?: string;
  publicUrl?: string;
}

// The codes /login?error= shows a message for (public/js/login.ts).
type Failure = 'sso_failed' | 'sso_unverified' | 'sso_no_account' | 'sso_unavailable';

// What the state cookie carries (base64url JSON).
interface Pending {
  state: string;
  verifier: string;
  nonce: string;
  next: string;
}

function readPending(raw: string | undefined): Pending | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const ok = p && typeof p.state === 'string' && typeof p.verifier === 'string' && typeof p.nonce === 'string' && typeof p.next === 'string';
    return ok ? p : null;
  } catch {
    return null;
  }
}

interface LinkRow {
  id: number;
  oidc_sub: string | null;
}

export function oidcConfigured({ issuer, clientId, publicUrl }: OidcOptions) {
  return !!(issuer && clientId && publicUrl);
}

export function createOidc(db: Db, { startSession }: Core, opts: OidcOptions) {
  const enabled = oidcConfigured(opts);
  const name = opts.name?.trim() || 'SSO';
  const publicUrl = (opts.publicUrl || '').replace(/\/+$/, '');
  const redirectUri = `${publicUrl}${CALLBACK_PATH}`;
  const bySub = db.prepare<[string], LinkRow>('SELECT id, oidc_sub FROM users WHERE oidc_sub = ?');
  const byEmail = db.prepare<[string], LinkRow>('SELECT id, oidc_sub FROM users WHERE email = ?');
  const link = db.prepare<[string, number]>('UPDATE users SET oidc_sub = ? WHERE id = ? AND oidc_sub IS NULL');

  // Discovery happens on first use, not at startup, so a provider that's down doesn't stop Pinnery
  // starting. A failure is dropped so the next sign-in tries again.
  let config: Promise<client.Configuration> | undefined;
  function getConfig() {
    config ??= (async () => {
      const issuer = new URL(opts.issuer!);
      // Plain http only for a provider on this machine (local testing); everything else needs https.
      const local = issuer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
      const auth = opts.clientSecret ? client.ClientSecretPost(opts.clientSecret) : client.None();
      return client.discovery(issuer, opts.clientId!, undefined, auth, local ? { execute: [client.allowInsecureRequests] } : undefined);
    })().catch((e: unknown) => {
      config = undefined;
      throw e;
    });
    return config;
  }

  function stateCookie(res: Response, value: string, maxAge: number) {
    const parts = [`${OIDC_COOKIE}=${value}`, `Path=/auth/oidc`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (res.req.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  // Ending a sign-in, either way, clears the state cookie. Appended after startSession's cookie,
  // which sets the header rather than adding to it.
  const fail = (res: Response, code: Failure) => {
    stateCookie(res, '', 0);
    res.redirect(302, `/login?error=${code}`);
  };

  // GET /api/oidc — whether the login page should offer SSO, and what to call it.
  function oidcStatus(req: Request, res: Response) {
    res.json(enabled ? { enabled: true, name } : { enabled: false });
  }

  // GET /auth/oidc/start?next=<path>
  async function oidcStart(req: Request, res: Response) {
    if (!enabled) return res.status(404).type('text').send('not found');
    res.set('Cache-Control', 'no-store');
    let cfg: client.Configuration;
    try {
      cfg = await getConfig();
    } catch (e) {
      console.warn(`oidc: discovery at ${opts.issuer} failed: ${e instanceof Error ? e.message : e}`);
      return fail(res, 'sso_unavailable');
    }
    const state = hex(crypto.randomBytes(32));
    const verifier = client.randomPKCECodeVerifier();
    const nonce = client.randomNonce();
    const pending: Pending = { state, verifier, nonce, next: safeNext(req.query.next) || '/' };
    stateCookie(res, Buffer.from(JSON.stringify(pending)).toString('base64url'), STATE_TTL_S);
    const to = client.buildAuthorizationUrl(cfg, {
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    res.redirect(302, to.href);
  }

  // GET /auth/oidc/callback?code=&state= — the provider's redirect back.
  async function oidcCallback(req: Request, res: Response) {
    if (!enabled) return res.status(404).type('text').send('not found');
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer'); // the URL carries the code
    // The cookie's Max-Age is the time limit. next is checked again, as the cookie came back from
    // the browser.
    const entry = readPending(parseCookies(req.headers.cookie)[OIDC_COOKIE]);
    if (!entry || req.query.state !== entry.state) return fail(res, 'sso_failed');
    const { state } = entry;
    if (req.query.error) return fail(res, 'sso_failed'); // e.g. the user cancelled at the provider

    let claims: client.IDToken;
    let email: unknown;
    let verified: unknown;
    try {
      const cfg = await getConfig();
      // The URL the provider sent the browser to, rebuilt on PINNERY_PUBLIC_URL (never the Host header).
      const current = new URL(redirectUri);
      current.search = new URL(req.originalUrl, 'http://pinnery.invalid').search;
      const tokens = await client.authorizationCodeGrant(cfg, current, {
        pkceCodeVerifier: entry.verifier,
        expectedState: state,
        expectedNonce: entry.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims()!;
      ({ email, email_verified: verified } = claims);
      if (email === undefined) {
        const info = await client.fetchUserInfo(cfg, tokens.access_token, claims.sub);
        ({ email, email_verified: verified } = info);
      }
    } catch (e) {
      console.warn(`oidc: sign-in failed: ${e instanceof Error ? e.message : e}`);
      return fail(res, 'sso_failed');
    }

    let user = bySub.get(claims.sub);
    if (!user) {
      if (verified !== true || typeof email !== 'string') return fail(res, 'sso_unverified');
      const match = byEmail.get(normaliseEmail(email));
      if (!match || match.oidc_sub !== null || !link.run(claims.sub, match.id).changes) return fail(res, 'sso_no_account');
      console.log(`oidc: linked user ${match.id} to their provider account`);
      user = match;
    }
    startSession(res, user.id);
    stateCookie(res, '', 0);
    res.redirect(302, safeNext(entry.next) || '/');
  }

  return { oidcStatus, oidcStart, oidcCallback };
}
