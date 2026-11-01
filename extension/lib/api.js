// Talks to the Pinnery server with the stored bearer token.

export class ApiError extends Error {
  constructor(status, message, kind, data = null) {
    super(message);
    this.status = status;
    this.kind = kind; // 'unreachable' | 'unauthorised' | 'server'
    this.data = data; // the server's JSON body
  }
}

export async function getConfig() {
  const c = await chrome.storage.local.get(['server', 'token', 'tokenId', 'tokenName']);
  return c.server && c.token ? c : null;
}

export const setConfig = (c) => chrome.storage.local.set(c);
export const clearConfig = () => chrome.storage.local.remove(['server', 'token', 'tokenId', 'tokenName']);

// Accepts what people type: adds https://, drops trailing slashes and paths.
export function normaliseServer(input) {
  let s = (input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

// Plain http sends the token (and the sign-in when connecting) in the clear. Allowed (a LAN box
// without TLS is a real setup), but worth a standing warning — except for the local-dev hosts,
// where nothing leaves the machine.
export function isInsecure(server) {
  try {
    const u = new URL(server);
    return u.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(u.hostname);
  } catch {
    return false;
  }
}

async function call(server, token, method, path, { body, type, timeout = 60000 } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof Blob)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  } else if (body instanceof Blob) {
    headers['Content-Type'] = type || body.type || 'application/octet-stream';
  }
  let res;
  try {
    res = await fetch(server + path, { method, headers, body, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'timed out' : 'connection failed';
    throw new ApiError(0, `Can't reach ${server} (${why})`, 'unreachable');
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') {
    throw new ApiError(res.status, `${server} doesn't look like a Pinnery server (HTTP ${res.status})`, 'unreachable');
  }
  if (res.status === 401) throw new ApiError(401, 'Token revoked — reconnect in the extension options', 'unauthorised');
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`, 'server', data);
  return data;
}

const q = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') s.set(k, v);
  return s.toString();
};

export const api = {
  // The connect flow's last step: trade the single-use code (plus the PKCE verifier) for a token. No token yet.
  exchangeCode: (server, body) => call(server, null, 'POST', '/api/connect/token', { body, timeout: 15000 }),
  revokeToken: (cfg, id) => call(cfg.server, cfg.token, 'DELETE', `/api/tokens/${id}`, { timeout: 15000 }),
  boards: (cfg) => call(cfg.server, cfg.token, 'GET', '/api/boards?sort=recent', { timeout: 15000 }),
  // Park an image on the server for the picker page: the bytes we fetched, or a URL for it to fetch.
  // Both answer { token }; the picker is opened at /pick/<token>.
  pickUpload: (cfg, blob, { sourceUrl, pageTitle, type }) =>
    call(cfg.server, cfg.token, 'POST', `/api/pick/upload?${q({ source_url: sourceUrl, page_title: pageTitle })}`, { body: blob, type }),
  pickUrl: (cfg, url, { sourceUrl, pageTitle }) =>
    call(cfg.server, cfg.token, 'POST', '/api/pick/url', { body: { url, source_url: sourceUrl, page_title: pageTitle } }),
  // Drop a parked image the picker never decided on. The pick token is its own credential.
  discardPick: (server, token) => call(server, null, 'POST', `/pick/${token}/discard`, { timeout: 15000 }),
};
