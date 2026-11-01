// The fetch chain. For each candidate URL (largest first):
//   1. fetch from the extension itself — host_permissions mean page CORS doesn't apply, and a
//      declarativeNetRequest session rule sends the page as Referer for hotlink checks
//   2. fetch from inside the page via the content script — same-origin / CORS-enabled images,
//      blob: URLs, anything gated on the page's own request context
// and if nothing came back:
//   3. hand the URL to the server, which fetches it itself.
// Whatever worked, the image ends up parked on the server as a "pick": board-less, fingerprinted,
// waiting for the board chosen on the server's picker page. The result
// records which step worked (`step`) so we can see how often each is needed.

import { api } from './api.js';

const FETCH_TIMEOUT = 20000;
const log = (...a) => console.log('[pinnery]', ...a);

// Reject obvious non-images without trusting content-type alone: hotlink protection likes to
// answer 200 with an HTML page.
async function looksLikeImage(blob) {
  const type = (blob.type || '').split(';')[0].trim().toLowerCase();
  if (/^(text\/|application\/(json|xml|xhtml))/.test(type)) return false;
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const ascii = String.fromCharCode(...head).trimStart();
  if (ascii.startsWith('<') || ascii.startsWith('{')) return false;
  return true;
}

let nextRuleId = 1 + Math.floor(Math.random() * 1e6);

// Step 1. The rule is scoped to this host and removed straight after.
async function extensionFetch(url, pageUrl) {
  const isHttp = /^https?:/i.test(url);
  const ruleId = nextRuleId++;
  if (isHttp && pageUrl) {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        condition: { requestDomains: [new URL(url).hostname], resourceTypes: ['xmlhttprequest'] },
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: pageUrl }] },
      }],
    });
  }
  try {
    const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const blob = await res.blob();
    if (!blob.size) return { ok: false, error: 'empty response' };
    if (!(await looksLikeImage(blob))) return { ok: false, error: `not an image (${blob.type || 'no type'})` };
    return { ok: true, blob };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timed out' : e.message };
  } finally {
    if (isHttp && pageUrl) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
  }
}

// Step 2. The content script returns a data: URL (messages are JSON).
async function pageFetch(job, url) {
  let r;
  try {
    r = await chrome.tabs.sendMessage(job.tabId, { type: 'fetch', url }, { frameId: job.frameId });
  } catch (e) {
    return { ok: false, error: `no content script (${e.message})` };
  }
  if (!r) return { ok: false, error: 'no reply from page' };
  if (!r.ok) return r;
  const blob = await (await fetch(r.dataUrl)).blob();
  if (!(await looksLikeImage(blob))) return { ok: false, error: `not an image (${blob.type || 'no type'})` };
  return { ok: true, blob };
}

// Run the chain and park the image on the server. Resolves with { token, step, url,
// attempts }; `token` is the pick token the picker page is opened with. Throws an ApiError / Error
// with a message fit to show.
export async function createPick(cfg, job) {
  const meta = { sourceUrl: job.pageUrl, pageTitle: job.pageTitle };
  const attempts = [];

  for (const url of job.candidates) {
    const r1 = await extensionFetch(url, job.pageUrl);
    if (r1.ok) return done(1, url, await api.pickUpload(cfg, r1.blob, { ...meta, type: r1.blob.type }));
    attempts.push(`1 ${url}: ${r1.error}`);
    const r2 = await pageFetch(job, url);
    if (r2.ok) return done(2, url, await api.pickUpload(cfg, r2.blob, { ...meta, type: r2.blob.type }));
    attempts.push(`2 ${url}: ${r2.error}`);
  }

  let lastError;
  for (const url of job.candidates) {
    if (!/^https?:/i.test(url)) continue;
    try {
      return done(3, url, await api.pickUrl(cfg, url, meta));
    } catch (e) {
      attempts.push(`3 ${url}: ${e.message}`);
      lastError = e;
      if (e.kind === 'unauthorised' || e.kind === 'unreachable') break;
    }
  }
  log('all steps failed', attempts);
  throw lastError || new Error("Couldn't fetch the image");

  function done(step, url, pick) {
    log(`parked via step ${step}`, url, attempts.length ? { failed: attempts } : '');
    return { ...pick, step, url, attempts };
  }
}
