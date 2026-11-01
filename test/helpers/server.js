import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMailSink, tokenFromLink } from './mail.js';

// Harness for API tests: each startServer() boots a real, isolated Pinnery (own data dir, own
// port) and hands back clients that are already signed in.
//
//   import { startServer } from './helpers/server.js';
//   const server = await startServer({ mail: true });
//   const admin = await server.adminClient();
//   const bob = await server.createUser('bob@example.com', 'bob-password-1');
//   const { status, body } = await bob.json('/api/me');   // { status: 200, body: { email: 'bob@example.com', ... } }
//   await server.stop();
//
// Throttle budget (src/auth.js). Counters are per server instance and keyed on the client IP, and
// every client here is 127.0.0.1, so ALL clients of one server share them:
//   - 10 failed credential checks per 15 min, shared by POST /api/login, POST /api/tokens,
//     POST /api/password (wrong `current`) and POST /api/email (wrong password) -> then 429.
//     Successful logins do not count. Each fixture below (adminClient, createUser) logs in OK.
//   - 10 bad/used/unknown emailed-link tokens per 15 min (GET/POST /api/signup|reset|confirm-email/:token).
//   - 10 failed connect-code exchanges (POST /api/connect/token).
//   - 5 POST /api/forgot per 15 min (every valid request counts, not only failures), and 3 per
//     address per hour (the 4th is silently dropped: 200 but no mail).
// To get a fresh budget without a new server, pass `{ ip: '127.0.0.7' }` to a client: it sends
// that as X-Forwarded-For (the server trusts one proxy hop), so the counters see another IP.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ADMIN_EMAIL = 'admin@example.com';
const INITIAL_PASSWORD = 'initial-pass-1';       // PINNERY_PASSWORD: must be changed at first sign-in
const ADMIN_PASSWORD = 'admin-pass-changed-1';   // what adminClient() changes it to

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

/**
 * A client for one identity. Credentials are sent automatically.
 * @typedef {object} Client
 * @property {string|null} email   Who it signs in as (null for anonymous / bearer-only).
 * @property {string|null} password  Their current password, kept for mintToken().
 * @property {(path: string, init?: RequestInit & { json?: any }) => Promise<Response>} fetch
 *   fetch() against the server. `path` is relative ('/api/me'). `init.json` is sent as a JSON
 *   body. Redirects are NOT followed (redirect: 'manual') unless init says otherwise.
 * @property {(path: string, init?: RequestInit & { json?: any }) => Promise<{ status: number, body: any, res: Response }>} json
 *   Like fetch, but reads the response: `body` is the parsed JSON, or null if it isn't JSON.
 * @property {(path: string) => Promise<{ status: number, body: any, res: Response }>} get
 * @property {(path: string, body?: any) => Promise<{ status: number, body: any, res: Response }>} post
 * @property {(path: string, body?: any) => Promise<{ status: number, body: any, res: Response }>} patch
 * @property {(path: string) => Promise<{ status: number, body: any, res: Response }>} del
 * @property {(name?: string) => Promise<string>} mintToken
 *   Create an API token (POST /api/tokens) with this client's email + password and return it.
 * @property {() => string|null} cookie  The current session cookie header value, if any.
 */

// Transport: the session COOKIE. Bearer tokens are the other option, but they can't do everything:
// /api/password and /api/email require a browser session (kind 'session'), POST /api/tokens needs
// the password anyway, and a cookie is what the web app itself uses. Anything a bearer token can
// do, a cookie can too. For bearer-specific tests use server.bearer(token) (from
// client.mintToken()).
function makeClient(base, { cookie = null, token = null, email = null, password = null, ip = null } = {}) {
  const state = { cookie };

  async function doFetch(p, init = {}) {
    const headers = new Headers(init.headers);
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      init = { ...init, body: JSON.stringify(init.json) };
    }
    if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    if (state.cookie && !headers.has('cookie')) headers.set('cookie', state.cookie);
    if (ip && !headers.has('x-forwarded-for')) headers.set('x-forwarded-for', ip);
    const { json: _json, ...rest } = init;
    const res = await fetch(new URL(p, base), { redirect: 'manual', ...rest, headers });
    // Follow the server's cookie changes (login sets it, logout clears it).
    const set = res.headers.getSetCookie().find((c) => c.startsWith('pinnery_session='));
    if (set) {
      const value = set.split(';')[0];
      state.cookie = value === 'pinnery_session=' ? null : value;
    }
    return res;
  }

  async function doJson(p, init) {
    const res = await doFetch(p, init);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body, res };
  }

  const client = {
    email,
    password,
    fetch: doFetch,
    json: doJson,
    get: (p) => doJson(p),
    post: (p, body) => doJson(p, { method: 'POST', ...(body !== undefined && { json: body }) }),
    patch: (p, body) => doJson(p, { method: 'PATCH', json: body }),
    del: (p) => doJson(p, { method: 'DELETE' }),
    cookie: () => state.cookie,
    async mintToken(name = 'test') {
      const { status, body } = await doJson('/api/tokens', { method: 'POST', json: { email: client.email, password: client.password, name } });
      if (status !== 201) throw new Error(`mintToken failed: ${status} ${JSON.stringify(body)}`);
      return body.token;
    },
  };
  return client;
}

/**
 * Boot an isolated Pinnery.
 * @param {{ env?: Record<string, string>, mail?: boolean }} [opts]
 *   env: extra/overriding environment variables (e.g. { PINNERY_PUBLIC_URL: '...' }).
 *   mail: also start the SMTP sink and point the server at it.
 * @returns {Promise<{
 *   url: string,
 *   dataDir: string,
 *   adminEmail: string,
 *   output: () => string,
 *   mail: import('./mail.js').MailSink | undefined,
 *   anon: (opts?: { ip?: string }) => Client,
 *   login: (email: string, password: string, opts?: { ip?: string }) => Promise<Client>,
 *   bearer: (token: string, opts?: { ip?: string }) => Client,
 *   adminClient: () => Promise<Client>,
 *   createUser: (email: string, password: string, opts?: { displayName?: string }) => Promise<Client>,
 *   stop: () => Promise<void>,
 * }>}
 *
 * - output(): everything the server printed to stdout/stderr so far.
 * - anon(): unauthenticated client (also useful for 401 checks).
 * - login(): POST /api/login and return a cookie client; throws on failure (a failed attempt
 *   counts against the throttle). Fails with 403 on API calls if the user must change password.
 * - bearer(): client that authenticates with `Authorization: Bearer <token>` only.
 * - adminClient(): the seeded admin (admin@example.com), signed in with the first-sign-in password
 *   change done. Created once and reused; every call returns the same client.
 * - createUser(): admin invites `email`, the invite link is used to sign up (display name
 *   defaults to the part before the @), and a client signed in as the new non-admin user is
 *   returned. Works with mail on or off. Re-using an email throws (409).
 * - stop(): kill the server, wait for it to exit, delete the data dir and close the sink.
 *   Idempotent.
 */
export async function startServer(opts = {}) {
  // freePort() releases the port before the server binds it, so a test file running in parallel
  // can rarely grab it first. Then our server exits with EADDRINUSE: try again on a new port.
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOnce(opts);
    } catch (err) {
      if (!err.portInUse || attempt === 5) throw err;
    }
  }
}

async function startOnce({ env = {}, mail = false }) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinnery-test-'));
  const port = await freePort();
  const sink = mail ? await startMailSink() : undefined;

  // A clean slate: nothing from the developer's own PINNERY_* / DATA_DIR / PORT leaks in.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PINNERY_|DATA_DIR$|PORT$)/.test(k)));
  Object.assign(childEnv, {
    DATA_DIR: dataDir,
    PORT: String(port),
    PINNERY_ADMIN_EMAIL: ADMIN_EMAIL,
    PINNERY_PASSWORD: INITIAL_PASSWORD,
  });
  if (sink) {
    Object.assign(childEnv, {
      PINNERY_SMTP_HOST: '127.0.0.1',
      PINNERY_SMTP_PORT: String(sink.port),
      PINNERY_SMTP_SECURE: 'false', // plain SMTP; the sink offers no STARTTLS either
      PINNERY_SMTP_FROM: 'Pinnery <pinnery@example.com>',
    });
  }
  Object.assign(childEnv, env);

  let out = '';
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (d) => { out += d; };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let exited = false;
  const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); }));
  const killOnExit = () => { if (!exited) child.kill('SIGKILL'); };
  process.once('exit', killOnExit); // don't orphan servers if a test run dies

  const url = `http://127.0.0.1:${port}`;
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (!exited) {
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exitPromise;
      clearTimeout(t);
    }
    process.off('exit', killOnExit);
    await sink?.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  // Wait until our own server says it's listening, then for /healthz, failing loudly (with the
  // server's own output) if it never comes up. Waiting for the log line matters: if another test
  // file's server took the port first, /healthz alone would answer from that one.
  const deadline = Date.now() + 20000;
  for (;;) {
    if (exited) {
      await stop();
      const err = new Error(`server exited during startup\n--- server output ---\n${out}`);
      err.portInUse = out.includes('EADDRINUSE');
      throw err;
    }
    try {
      if (out.includes(`listening on :${port}`) && (await fetch(`${url}/healthz`)).ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`server not healthy after 20s\n--- server output ---\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const anon = ({ ip } = {}) => makeClient(url, { ip });
  const bearer = (token, { ip } = {}) => makeClient(url, { token, ip });

  async function login(email, password, { ip } = {}) {
    const client = makeClient(url, { email, password, ip });
    const { status, body } = await client.post('/api/login', { email, password });
    if (status !== 200) throw new Error(`login as ${email} failed: ${status} ${JSON.stringify(body)}`);
    return client;
  }

  // First admin sign-in: PINNERY_PASSWORD only works to get in, then everything but
  // /api/password is closed (403 password_change_required) until a new password is set.
  let admin;
  const adminClient = () => admin ??= (async () => {
    const client = await login(ADMIN_EMAIL, INITIAL_PASSWORD);
    const { status, body } = await client.post('/api/password', { current: INITIAL_PASSWORD, new: ADMIN_PASSWORD });
    if (status !== 200) throw new Error(`admin password change failed: ${status} ${JSON.stringify(body)}`);
    client.password = ADMIN_PASSWORD;
    return client;
  })().catch((err) => { admin = undefined; throw err; }); // don't cache a failure

  async function createUser(email, password, { displayName } = {}) {
    const adminC = await adminClient();
    const invite = await adminC.post('/api/invites', { email });
    if (invite.status !== 201) throw new Error(`invite for ${email} failed: ${invite.status} ${JSON.stringify(invite.body)}`);
    // `link` is in the reply whether or not mail is on; signing up signs the new user in.
    const client = makeClient(url, { email: email.toLowerCase(), password });
    const signup = await client.post(`/api/signup/${tokenFromLink(invite.body.link)}`, { display_name: displayName ?? email.split('@')[0], password });
    if (signup.status !== 201) throw new Error(`signup for ${email} failed: ${signup.status} ${JSON.stringify(signup.body)}`);
    return client;
  }

  return { url, dataDir, adminEmail: ADMIN_EMAIL, output: () => out, mail: sink, anon, login, bearer, adminClient, createUser, stop };
}
