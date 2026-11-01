import { api, getConfig, setConfig, clearConfig, normaliseServer, isInsecure, ApiError } from './lib/api.ts';
import type { Config } from './lib/api.ts';
import { icon } from './lib/icons.ts';

// options.html defines every id used here, so lookups are asserted rather than null-checked.
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('connect');

// Not in lib.dom yet: Chromium's client hints, and Brave's marker.
type BrowserNavigator = Navigator & {
  userAgentData?: { platform?: string; brands?: { brand: string }[] };
  brave?: unknown;
};

// The test result pill under the buttons: kind is 'ok' | 'error' | 'pending', or nothing to hide it.
function setCheck(kind: 'ok' | 'error' | 'pending' | null, text = '') {
  const out = $('check');
  out.classList.toggle('hidden', !kind);
  out.className = `pill${kind === 'error' ? ' error' : kind === 'pending' ? ' pending' : ''}${kind ? '' : ' hidden'}`;
  out.replaceChildren();
  if (!kind) return;
  if (kind !== 'pending') out.append(icon(kind === 'ok' ? 'check-circle' : 'alert-circle'));
  out.append(document.createTextNode(text));
}

// Plain http is allowed but flagged, while typing the address and once connected.
const INSECURE = 'Unencrypted connection: your sign-in and this browser\'s token can be read by others on this network. Use https if you can.';
function setWarn(id: string, server: string | null) {
  const out = $(id);
  const show = isInsecure(server);
  out.classList.toggle('hidden', !show);
  out.replaceChildren();
  if (show) out.append(icon('alert-outline'), document.createTextNode(INSECURE));
}

function defaultName() {
  const nav: BrowserNavigator = navigator;
  const platform = nav.userAgentData?.platform || nav.platform || '';
  const os = /mac/i.test(platform) ? 'Mac' : /win/i.test(platform) ? 'Windows' : /linux/i.test(platform) ? 'Linux' : /cros/i.test(platform) ? 'ChromeOS' : platform;
  // Brave hides itself from the brand list; Edge/Opera/Vivaldi report their own brand.
  const brands = (nav.userAgentData?.brands || []).map((b) => b.brand);
  const browser = nav.brave ? 'Brave'
    : brands.find((b) => /edge|opera|vivaldi/i.test(b))?.replace(/^Microsoft /, '') || 'Chrome';
  return os ? `${browser} on ${os}` : browser;
}

async function show() {
  const cfg = await getConfig();
  form.classList.toggle('hidden', !!cfg);
  $('status').classList.toggle('hidden', !cfg);
  setCheck(null);
  if (cfg) {
    $('status-server').textContent = cfg.server;
    $<HTMLAnchorElement>('status-server').href = cfg.server;
    $('status-name').textContent = cfg.tokenName ? `as “${cfg.tokenName}”` : '';
    setWarn('status-warn', cfg.server);
    check();
  } else {
    $('server').focus();
  }
}

// PKCE (RFC 7636): a random verifier stays here; only its SHA-256 goes to the server with the
// request, so a code seen in transit is useless without the verifier.
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function pkce() {
  const verifier = random(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

// Connect through the site: Chrome opens <server>/connect in an auth window, where the user signs
// in (if needed) and approves this browser; the page then redirects to our chromiumapp.org URL
// with a single-use code, which we trade for the token together with the PKCE verifier.
async function connect(server: string, name: string) {
  const redirectUri = chrome.identity.getRedirectURL();
  const { verifier, challenge } = await pkce();
  const state = random(16);
  const url = new URL('/connect', server);
  url.search = new URLSearchParams({
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    name,
  }).toString();
  let result: string | undefined;
  try {
    result = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(/did not approve|canceled|cancelled|closed/i.test(msg) ? 'Connection cancelled' : `Couldn't open the connect page: ${msg}`);
  }
  const back = new URL(result!); // only undefined for non-interactive flows
  if (back.searchParams.get('state') !== state) throw new Error('Connection failed: the server replied to a different request');
  if (back.searchParams.get('error')) throw new Error('Connection cancelled');
  const code = back.searchParams.get('code');
  if (!code) throw new Error('Connection failed: no code returned');
  return api.exchangeCode(server, { code, code_verifier: verifier, redirect_uri: redirectUri });
}

$<HTMLInputElement>('name').value = defaultName();
$<HTMLInputElement>('server').addEventListener('input', () => setWarn('connect-warn', normaliseServer($<HTMLInputElement>('server').value)));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('connect-error');
  err.textContent = '';
  const server = normaliseServer($<HTMLInputElement>('server').value);
  if (!server) { err.textContent = 'Enter the server address, e.g. https://pinnery.example.com'; return; }
  $<HTMLButtonElement>('connect-btn').disabled = true;
  try {
    const t = await connect(server, $<HTMLInputElement>('name').value.trim() || defaultName());
    await setConfig({ server, token: t.token, tokenId: t.id, tokenName: t.name });
    await show();
  } catch (e2) {
    err.textContent = (e2 as Error).message;
  } finally {
    $<HTMLButtonElement>('connect-btn').disabled = false;
  }
});

// Check the stored token against the server: run whenever the page opens, and by the button.
// A rejected token (revoked, or its user removed) means this browser isn't connected any more.
async function check() {
  const cfg = await getConfig();
  if (!cfg) return;
  const title = $('status-title');
  const dot = $('status-dot');
  title.textContent = 'Checking…';
  dot.className = 'dot pending';
  setCheck('pending', 'Checking…');
  try {
    const boards = await api.boards(cfg);
    title.textContent = 'Connected';
    dot.className = 'dot';
    setCheck('ok', `Connected — ${boards.length} ${boards.length === 1 ? 'board' : 'boards'}`);
    checkUpdate(cfg);
  } catch (e) {
    dot.className = 'dot bad';
    if (e instanceof ApiError && e.kind === 'unauthorised') {
      title.textContent = 'Not connected';
      setCheck('error', 'This browser\u2019s token was revoked or no longer works. Disconnect, then connect again.');
    } else {
      title.textContent = 'Can\u2019t reach the server';
      setCheck('error', (e as Error).message);
    }
  }
}

$('test').onclick = check;

// The server ships its build of the extension (Settings → Devices) and reports a fingerprint of it.
// The zip it serves carries the same fingerprint in manifest.json's version_name ("<version>+<fp>"),
// so a mismatch means the server has a different build than the one installed here.
async function checkUpdate(cfg: Config) {
  const box = $('update');
  box.classList.add('hidden');
  try {
    const { extension_fingerprint: latest }: { extension_fingerprint?: string } = await fetch(`${cfg.server}/healthz`).then((r) => r.json());
    const mine = (chrome.runtime.getManifest().version_name || '').split('+')[1] || '';
    if (!latest || latest === mine) return;
    const link = document.createElement('a');
    link.href = `${cfg.server}/settings/devices`;
    link.target = '_blank';
    link.textContent = 'Download it from Settings → Devices';
    box.replaceChildren(document.createTextNode('Your server has a newer version of this extension. '), link, document.createTextNode(', unzip over this folder, then reload the extension.'));
    box.classList.remove('hidden');
  } catch { /* older server without a fingerprint, or offline: nothing to say */ }
}

// Revoke this browser's token on the server (best effort — the server may be unreachable or the
// token already revoked), then forget it locally either way.
$('disconnect').onclick = async () => {
  const cfg = await getConfig();
  $<HTMLButtonElement>('disconnect').disabled = true;
  if (cfg?.tokenId) await api.revokeToken(cfg, cfg.tokenId).catch(() => {});
  await clearConfig();
  $<HTMLButtonElement>('disconnect').disabled = false;
  await show();
};

show();
