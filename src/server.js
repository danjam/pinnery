import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from './db.js';
import { createAuth, safeNext, parseConnectParams } from './auth.js';
import { createMailer } from './mail.js';
import { createStore, ImageError } from './images.js';
import { createRoutes, createImageRoutes } from './routes.js';
import { createUserRoutes } from './users.js';
import { zipDirectory, walk } from './zip.js';

const PORT = Number(process.env.PORT) || 3420;
const DATA_DIR = process.env.DATA_DIR || '/data';
const PASSWORD = process.env.PINNERY_PASSWORD;
const ADMIN_EMAIL = process.env.PINNERY_ADMIN_EMAIL;
// Base URL of emailed links (e.g. https://pinnery.example.com); without it, the request's own origin.
const PUBLIC_URL = process.env.PINNERY_PUBLIC_URL || '';
// How many reverse proxies sit in front of Pinnery (default 1). Each adds the address it saw to the
// end of X-Forwarded-For, so the visitor's real IP is that many entries from the end; anything
// earlier was written by the visitor. 0 when there's no proxy, or anyone can claim any IP. Passed to
// Express as "trust proxy", which also decides when X-Forwarded-Proto counts (Secure cookie, links).
const PROXIES = (process.env.PINNERY_PROXIES || '1').trim();
if (!/^\d+$/.test(PROXIES)) {
  console.error(`PINNERY_PROXIES must be the number of proxies in front of Pinnery (0 for none), not "${PROXIES}" — refusing to start`);
  process.exit(1);
}

// Together they create the first (admin) account on first start; see auth.js.
const missing = [['PINNERY_ADMIN_EMAIL', ADMIN_EMAIL], ['PINNERY_PASSWORD', PASSWORD]].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set — refusing to start`);
  process.exit(1);
}

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(srcDir, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(srcDir, '..', 'package.json'), 'utf8')).version;
// The extension version this server ships (Settings → Download); the extension compares it with its own.
const extensionDir = path.join(srcDir, '..', 'extension');
// Fingerprint of the extension this server ships: a hash over every file's path and bytes, in a
// fixed order. The download stamps it into manifest.json (version_name "<version>+<fingerprint>")
// and /healthz reports it, so the extension can tell when the server has a different build of it.
const EXTENSION_FINGERPRINT = (() => {
  const h = crypto.createHash('sha256');
  for (const rel of walk(extensionDir)) h.update(rel).update('\0').update(fs.readFileSync(path.join(extensionDir, rel))).update('\0');
  return h.digest('hex').slice(0, 12);
})();
const stampManifest = (rel, buf) => {
  if (rel !== 'manifest.json') return buf;
  const m = JSON.parse(buf.toString('utf8'));
  m.version_name = `${m.version}+${EXTENSION_FINGERPRINT}`;
  return Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
};
const db = openDb(DATA_DIR);
const store = createStore(DATA_DIR);
const mailer = createMailer();
const auth = createAuth(db, { password: PASSWORD, adminEmail: ADMIN_EMAIL, mailer, publicUrl: PUBLIC_URL });

// Delete files no pin references (crash leftovers) and warn about pins whose original is missing.
function sweep() {
  const shas = db.prepare('SELECT DISTINCT sha256 FROM pins').all().map((r) => r.sha256);
  const removed = store.sweep(new Set(shas));
  if (removed) console.log(`sweep: removed ${removed} orphaned file(s)`);
  const missing = shas.filter((s) => !store.original(s));
  if (missing.length) console.warn(`sweep: ${missing.length} pin hash(es) have no original file`);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(PROXIES));

app.get('/healthz', (req, res) => res.json({ ok: true, version: VERSION, extension_fingerprint: EXTENSION_FINGERPRINT }));

app.use('/css', express.static(path.join(publicDir, 'css'), { maxAge: 0 }));
app.use('/js', express.static(path.join(publicDir, 'js'), { maxAge: 0 }));
app.get('/icon.svg', (req, res) => res.sendFile(path.join(publicDir, 'icon.svg')));
// Installable web app: manifest, icons and the share-target service worker (served from the root so
// its scope covers /share). None of these need a session.
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(publicDir, 'manifest.webmanifest')));
app.use('/app-icons', express.static(path.join(publicDir, 'app-icons'), { maxAge: '7d' }));
app.get('/sw.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(publicDir, 'sw.js')); });

// ?next=<same-origin path> continues there after signing in (the extension's /connect uses it).
app.get('/login', (req, res) => {
  const session = auth.identify(req);
  const next = safeNext(req.query.next) || '/';
  if (session) return res.redirect(302, session.user.must_change_password ? `/password?next=${encodeURIComponent(next)}` : next);
  res.sendFile(path.join(publicDir, 'login.html'));
});
app.post('/api/login', express.json({ limit: '4kb' }), express.urlencoded({ extended: false, limit: '4kb' }), auth.login);
app.post('/api/logout', auth.logout);
// "Choose a new password": where a required change is made (also reachable by choice). Everything
// else is closed until it's done — see requireApi/requirePage in auth.js.
app.get('/password', (req, res) => {
  const session = auth.identify(req);
  if (!session) return res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl)}`);
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'password.html'));
});
app.post('/api/password', express.json({ limit: '4kb' }), auth.changePassword);
app.get('/api/me', auth.requireApi, auth.me);
app.patch('/api/me', express.json({ limit: '4kb' }), auth.requireApi, auth.updateMe);
// Email + password in, API token out, for scripts and the API. Same throttle as login.
app.post('/api/tokens', express.json({ limit: '4kb' }), auth.createToken);

// Emailed links (auth.js): each has a page that reads the token from its URL and a public API pair,
// GET to check the link and POST to use it. The page HTML changes nothing by itself.
const json = express.json({ limit: '4kb' });
const linkPage = (file) => (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.sendFile(path.join(publicDir, file));
};
app.get('/api/mail', auth.mailStatus);
app.get('/signup/:token', linkPage('signup.html'));
app.get('/api/signup/:token', auth.inviteInfo);
app.post('/api/signup/:token', json, auth.signup);
app.get('/forgot', linkPage('forgot.html'));
app.post('/api/forgot', json, auth.forgot);
app.get('/reset/:token', linkPage('reset.html'));
app.get('/api/reset/:token', auth.resetInfo);
app.post('/api/reset/:token', json, auth.reset);
app.get('/confirm-email/:token', linkPage('confirm-email.html'));
app.get('/api/confirm-email/:token', auth.confirmEmailInfo);
app.post('/api/confirm-email/:token', json, auth.confirmEmail);
// Signed in: invites (admins), changing your own email, revoking all your tokens at once.
app.get('/api/invites', auth.requireApi, auth.requireAdmin, auth.listInvites);
app.post('/api/invites', json, auth.requireApi, auth.requireAdmin, auth.createInvite);
app.delete('/api/invites/:id', auth.requireApi, auth.requireAdmin, auth.cancelInvite);
app.post('/api/email', json, auth.requireApi, auth.requestEmailChange);
app.delete('/api/tokens', auth.requireApi, auth.revokeAllTokens);

// The extension connects through the site instead (see auth.js): /connect asks the signed-in user
// to approve the browser and hands a single-use code back to the extension, which trades it here.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
app.get('/connect', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  const p = parseConnectParams(req.query);
  if (p.error) {
    return res.status(400).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<title>Pinnery</title><link rel="stylesheet" href="/css/app.css"></head><body class="login-page"><div class="login">
<h1 class="brand"><img src="/icon.svg" alt="" width="32" height="32">Pinnery</h1>
<p class="error">This connect link is invalid: ${escapeHtml(p.error)}.</p></div></body></html>`);
  }
  next();
}, auth.requirePage, (req, res) => res.sendFile(path.join(publicDir, 'connect.html')));
app.post('/connect/decide', express.json({ limit: '4kb' }), auth.connectDecide);
app.post('/api/connect/token', express.json({ limit: '4kb' }), auth.exchangeCode);
app.get('/api/tokens', auth.requireApi, auth.listTokens);
app.delete('/api/tokens/:id', auth.requireApi, auth.revokeToken);

const routes = createRoutes(db, store, { dataDir: DATA_DIR, mailer, publicUrl: PUBLIC_URL });
app.use('/api', auth.requireApi, routes.api);
// Settings → Users (admins): list, promote/demote, delete, hand over a reset link. See users.js.
// After the API, whose /api/users/directory (the share picker) is for everyone.
app.use('/api/users', json, auth.requireApi, auth.requireAdmin, createUserRoutes(db, { auth, deletePinRows: routes.deletePinRows }));
app.use(['/i', '/t'], auth.requireApi);
app.use(createImageRoutes(db, store));
// The extension's board picker: a page authenticated by its pending token alone (see routes.js).
app.use('/pick', routes.pick);

// The Chrome extension, zipped on demand from the folder shipped in the image (see settings).
app.get('/extension.zip', auth.requirePage, async (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="pinnery-extension.zip"');
  res.set('Cache-Control', 'no-cache');
  res.type('application/zip').send(await zipDirectory(extensionDir, 'pinnery-extension', stampManifest));
});

const index = path.join(publicDir, 'index.html');
// Android share target, after the service worker has parked the image (see sw.js).
app.get('/share', auth.requirePage, (req, res) => res.sendFile(path.join(publicDir, 'share.html')));
app.get(['/', '/b/:id', '/settings', '/settings/:tab'], auth.requirePage, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(index);
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.status(404).type('text').send('not found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // ImageError carries a status and a message safe to show (including 502 for a failed upstream
  // fetch). Body-parser errors have a type. Anything else is a bug: log it, say nothing specific.
  let status = err.status || err.statusCode || 500;
  let message = err.message;
  if (err.type === 'entity.too.large') { status = 413; message = 'upload too large'; }
  else if (err.type === 'entity.parse.failed') { status = 400; message = 'invalid JSON'; }
  else if (!(err instanceof ImageError) && !err.type) { status = 500; message = 'internal error'; console.error(err); }
  if (res.headersSent) return;
  res.status(status).json({ error: message, ...(err instanceof ImageError && err.extra) });
});

sweep();
// Express 5 hands a failed bind (e.g. the port is taken) to this callback instead of throwing.
const server = app.listen(PORT, '0.0.0.0', (err) => {
  if (err) {
    console.error(`can't listen on :${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`pinnery ${VERSION} listening on :${PORT}, data in ${DATA_DIR}`);
});

// `docker stop` sends SIGTERM, and node as PID 1 ignores it unless handled, so Docker would wait,
// then SIGKILL mid-write. Stop taking requests, let in-flight ones finish, close the database.
function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  setTimeout(() => process.exit(0), 5000).unref(); // don't wait forever on a slow request
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
