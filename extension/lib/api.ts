// Talks to the Pinnery server with the stored bearer token.

export type ApiErrorKind = 'unreachable' | 'unauthorised' | 'server';

export class ApiError extends Error {
  status: number;
  kind: ApiErrorKind;
  data: Record<string, unknown> | null;

  constructor(status: number, message: string, kind: ApiErrorKind, data: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.data = data; // the server's JSON body
  }
}

// What the connect flow stores in chrome.storage.local.
export interface Config {
  server: string;
  token: string;
  tokenId?: number;
  tokenName?: string;
}

// The token the server mints in exchange for a connect code.
export interface TokenGrant {
  id: number;
  name: string;
  created_at: string;
  token: string;
}

// A parked image's pick token; the picker is opened at /pick/<token>.
export interface Pick {
  token: string;
}

export async function getConfig(): Promise<Config | null> {
  // Storage is untyped; the fields are only ever written by setConfig.
  const c = await chrome.storage.local.get(['server', 'token', 'tokenId', 'tokenName']);
  return c.server && c.token ? (c as unknown as Config) : null;
}

export const setConfig = (c: Config) => chrome.storage.local.set(c);
export const clearConfig = () => chrome.storage.local.remove(['server', 'token', 'tokenId', 'tokenName']);

// Accepts what people type: adds https://, drops trailing slashes and paths.
export function normaliseServer(input: string | null | undefined): string | null {
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
export function isInsecure(server: string | null): boolean {
  try {
    const u = new URL(server ?? '');
    return u.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(u.hostname);
  } catch {
    return false;
  }
}

interface CallOptions {
  body?: Blob | object;
  type?: string;
  timeout?: number;
}

async function call<T>(
  server: string,
  token: string | null,
  method: string,
  path: string,
  { body, type, timeout = 60000 }: CallOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof Blob) {
    headers['Content-Type'] = type || body.type || 'application/octet-stream';
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(server + path, { method, headers, body: payload, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const why = (e as Error).name === 'TimeoutError' ? 'timed out' : 'connection failed';
    throw new ApiError(0, `Can't reach ${server} (${why})`, 'unreachable');
  }
  const data: Record<string, unknown> | null = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') {
    throw new ApiError(res.status, `${server} doesn't look like a Pinnery server (HTTP ${res.status})`, 'unreachable');
  }
  if (res.status === 401) throw new ApiError(401, 'Token revoked — reconnect in the extension options', 'unauthorised');
  if (!res.ok) throw new ApiError(res.status, (data.error as string) || `HTTP ${res.status}`, 'server', data);
  // The shape is the caller's claim about the endpoint; the server's JSON isn't validated here.
  return data as T;
}

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') s.set(k, v);
  return s.toString();
};

// The connect flow's PKCE exchange body.
export interface CodeExchange {
  code: string;
  code_verifier: string;
  redirect_uri: string;
}

interface PickMeta {
  sourceUrl?: string;
  pageTitle?: string;
}

export const api = {
  // The connect flow's last step: trade the single-use code (plus the PKCE verifier) for a token. No token yet.
  exchangeCode: (server: string, body: CodeExchange) =>
    call<TokenGrant>(server, null, 'POST', '/api/connect/token', { body, timeout: 15000 }),
  revokeToken: (cfg: Config, id: number) =>
    call<Record<string, unknown>>(cfg.server, cfg.token, 'DELETE', `/api/tokens/${id}`, { timeout: 15000 }),
  boards: (cfg: Config) =>
    call<unknown[]>(cfg.server, cfg.token, 'GET', '/api/boards?sort=recent', { timeout: 15000 }),
  // Park an image on the server for the picker page: the bytes we fetched, or a URL for it to fetch.
  // Both answer { token }; the picker is opened at /pick/<token>.
  pickUpload: (cfg: Config, blob: Blob, { sourceUrl, pageTitle, type }: PickMeta & { type?: string }) =>
    call<Pick>(cfg.server, cfg.token, 'POST', `/api/pick/upload?${q({ source_url: sourceUrl, page_title: pageTitle })}`, { body: blob, type }),
  pickUrl: (cfg: Config, url: string, { sourceUrl, pageTitle }: PickMeta) =>
    call<Pick>(cfg.server, cfg.token, 'POST', '/api/pick/url', { body: { url, source_url: sourceUrl, page_title: pageTitle } }),
  // Drop a parked image the picker never decided on. The pick token is its own credential.
  discardPick: (server: string, token: string) =>
    call<Record<string, unknown>>(server, null, 'POST', `/pick/${token}/discard`, { timeout: 15000 }),
};
