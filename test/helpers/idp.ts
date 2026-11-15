import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// A minimal OpenID Connect provider for the SSO tests: discovery, an authorization step the test
// drives itself (authorize()), a token endpoint that checks PKCE and the client secret, JWKS and
// userinfo. ID tokens are RS256, signed with a key made at startup.
//
//   const idp = await startIdp();
//   // point Pinnery at idp.issuer with CLIENT_ID / CLIENT_SECRET
//   const code = idp.authorize(authorizationUrl, { sub: 'u1', email: 'a@example.com', email_verified: true });
//   idp.loginAs({ ... });   // or let a browser through /authorize as this identity
//   await idp.close();

export const CLIENT_ID = 'pinnery-test';
export const CLIENT_SECRET = 'test-client-secret';

export interface Identity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  /** Put the email only in userinfo, not the ID token. */
  emailInUserinfoOnly?: boolean;
  /** Override the nonce the ID token carries. */
  nonce?: string;
}

interface Grant {
  identity: Identity;
  challenge: string;
  nonce: string;
  redirectUri: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export async function startIdp() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, Identity>();
  let issuer = '';
  let loginAs: Identity | null = null;

  // The provider's side of the authorization step: check the request Pinnery redirected to and
  // return the code it would send back, for `identity`.
  function authorize(location: string, identity: Identity): string {
    const u = new URL(location);
    if (`${u.origin}${u.pathname}` !== `${issuer}/authorize`) throw new Error(`not our authorize endpoint: ${location}`);
    const q = (k: string) => u.searchParams.get(k) ?? '';
    if (q('client_id') !== CLIENT_ID || q('response_type') !== 'code' || q('code_challenge_method') !== 'S256' || !q('nonce') || !q('state')) {
      throw new Error(`bad authorization request: ${location}`);
    }
    const code = crypto.randomBytes(16).toString('hex');
    grants.set(code, { identity, challenge: q('code_challenge'), nonce: q('nonce'), redirectUri: q('redirect_uri') });
    return code;
  }

  function idToken(identity: Identity, nonce: string) {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { iss: issuer, aud: CLIENT_ID, sub: identity.sub, iat: now, exp: now + 300, nonce: identity.nonce ?? nonce };
    if (!identity.emailInUserinfoOnly) Object.assign(claims, { email: identity.email, email_verified: identity.email_verified });
    const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test' }))}.${b64url(JSON.stringify(claims))}`;
    return `${input}.${b64url(crypto.sign('sha256', Buffer.from(input), privateKey))}`;
  }

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    let body = '';
    for await (const chunk of req) body += chunk;
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    }
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    // A browser arriving to sign in (the browser tests): signed in at once as loginAs.
    if (url.pathname === '/authorize' && loginAs) {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', authorize(url.href, loginAs));
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(body);
      const grant = grants.get(p.get('code') ?? '');
      grants.delete(p.get('code') ?? '');
      const verifier = p.get('code_verifier') ?? '';
      if (!grant || p.get('client_id') !== CLIENT_ID || p.get('client_secret') !== CLIENT_SECRET
        || p.get('redirect_uri') !== grant.redirectUri || b64url(crypto.createHash('sha256').update(verifier).digest()) !== grant.challenge) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      const access = crypto.randomBytes(16).toString('hex');
      tokens.set(access, grant.identity);
      return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 300, id_token: idToken(grant.identity, grant.nonce) });
    }
    if (url.pathname === '/userinfo') {
      const identity = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!identity) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, { sub: identity.sub, email: identity.email, email_verified: identity.email_verified });
    }
    json(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    authorize,
    /** Answer browsers at /authorize by signing them straight in as `identity`. */
    loginAs(identity: Identity) { loginAs = identity; },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
