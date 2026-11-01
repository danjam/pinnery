import http from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent';
import { ImageError } from './images.ts';

export const MAX_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Pinnery/0.1 (+https://github.com/danjam/pinnery)';

// SSRF guard: the server fetches whatever URL it's given, so the agents refuse to connect to
// private, loopback, link-local and other reserved (non-unicast) addresses — checked on literal
// IP hosts and inside the DNS lookup, so the address vetted is the one connected to.
// PINNERY_FETCH_ALLOW is a comma-separated list of IPs or CIDRs to allow regardless.
const allowIPAddressList = (process.env.PINNERY_FETCH_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
const agents = {
  'http:': new RequestFilteringHttpAgent({ allowIPAddressList }),
  'https:': new RequestFilteringHttpsAgent({ allowIPAddressList }),
};
const isBlockedError = (e: Error) => /^DNS lookup .* is not allowed/.test(e.message || '');

function checkUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new ImageError(400, 'invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImageError(400, 'only http and https URLs are allowed');
  return url;
}

function request(url: URL, headers: OutgoingHttpHeaders, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const req = (secure ? https : http).request(url, { headers, agent: secure ? agents['https:'] : agents['http:'], signal }, resolve);
    req.on('error', reject);
    req.end();
  });
}

async function readBody(res: IncomingMessage): Promise<Buffer> {
  const declared = Number(res.headers['content-length']);
  if (declared > MAX_BYTES) {
    res.destroy();
    throw new ImageError(413, `image too large (${Math.round(declared / 1048576)} MB, limit ${MAX_BYTES / 1048576} MB)`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      res.destroy();
      throw new ImageError(413, `image too large (limit ${MAX_BYTES / 1048576} MB)`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Download an image URL into a Buffer. http/https only, bounded in time and size, redirects
// followed by hand so every hop goes through the same scheme check and filtering agents.
// The caller verifies it's really an image (sharp) — content-type headers lie.
export async function fetchImage(rawUrl: string, referer?: string): Promise<Buffer> {
  let url = checkUrl(rawUrl);
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8' };
  if (referer) headers.Referer = referer;
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    for (let hop = 0; ; hop++) {
      const res = await request(url, headers, signal);
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw new ImageError(502, 'too many redirects');
        url = checkUrl(res.headers.location, url);
        continue;
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw new ImageError(502, `fetch failed: HTTP ${res.statusCode}`);
      }
      return await readBody(res);
    }
  } catch (e) {
    if (e instanceof ImageError) throw e;
    const err = e instanceof Error ? e : new Error(String(e));
    if (isBlockedError(err)) throw new ImageError(400, `that URL is blocked: ${url.hostname} points to a private or reserved address`);
    if (err.name === 'AbortError' || ('code' in err && err.code === 'ABORT_ERR')) throw new ImageError(502, 'fetch timed out');
    // The error text can name internal hosts and addresses (DNS, connect errors): log it, don't return it.
    console.warn(`fetch: ${url.href}: ${err.message}`);
    throw new ImageError(502, 'fetch failed');
  }
}
