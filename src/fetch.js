import http from 'node:http';
import https from 'node:https';
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent';
import { ImageError } from './images.js';

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
const isBlockedError = (e) => /^DNS lookup .* is not allowed/.test(e.message || '');

function checkUrl(raw, base) {
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    throw new ImageError(400, 'invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImageError(400, 'only http and https URLs are allowed');
  return url;
}

function request(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, { headers, agent: agents[url.protocol], signal }, resolve);
    req.on('error', reject);
    req.end();
  });
}

async function readBody(res) {
  const declared = Number(res.headers['content-length']);
  if (declared > MAX_BYTES) {
    res.destroy();
    throw new ImageError(413, `image too large (${Math.round(declared / 1048576)} MB, limit ${MAX_BYTES / 1048576} MB)`);
  }
  const chunks = [];
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
export async function fetchImage(rawUrl, referer) {
  let url = checkUrl(rawUrl);
  const headers = { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8' };
  if (referer) headers.Referer = referer;
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    for (let hop = 0; ; hop++) {
      const res = await request(url, headers, signal);
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
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
    if (isBlockedError(e)) throw new ImageError(400, `that URL is blocked: ${url.hostname} points to a private or reserved address`);
    if (e.name === 'AbortError' || e.code === 'ABORT_ERR') throw new ImageError(502, 'fetch timed out');
    throw new ImageError(502, `fetch failed: ${e.message}`);
  }
}
