// Content script, every frame. Remembers the last right-clicked element so the picker can find the
// largest version of the image (srcset, <picture>, lazy-load attributes), fetches images from inside
// the page when the extension's own fetch is refused, and shows the "pinned" toast.

import type { ContentMessage, PageFetchReply, ResolveReply, WorkerMessage } from './lib/messages.ts';

declare global {
  interface Window {
    __pinneryContent?: boolean;
  }
}

interface SrcsetEntry {
  url: string;
  w: number;
  x: number;
}

(() => {
  if (window.__pinneryContent) return;
  window.__pinneryContent = true;

  let lastTarget: EventTarget | null = null;
  addEventListener('contextmenu', (e) => { lastTarget = e.composedPath()[0] || e.target; }, true);

  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-full', 'data-full-src', 'data-large',
    'data-large-src', 'data-zoom-src', 'data-zoom-image', 'data-hi-res', 'data-image', 'data-url'];
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?|#|$)/i;

  const abs = (u: string | null | undefined): string | null => {
    if (!u || typeof u !== 'string') return null;
    u = u.trim();
    if (!u || u.startsWith('javascript:')) return null;
    try { return new URL(u, document.baseURI).href; } catch { return null; }
  };

  // "url 640w, url2 1280w" or "url 1x, url2 2x" -> [{ url, w, x }]. Walks the string the way the
  // spec does, since URLs themselves may contain commas (CDN transform paths).
  function parseSrcset(input: string | null): SrcsetEntry[] {
    const out: SrcsetEntry[] = [];
    const s = input || '';
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      let start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      let url = s.slice(start, i);
      let desc = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        start = i;
        while (i < s.length && s[i] !== ',') i++;
        desc = s.slice(start, i);
        i++;
      }
      const m = desc.match(/(\d+(?:\.\d+)?)\s*([wx])/);
      const href = abs(url);
      if (href) out.push({ url: href, w: m && m[2] === 'w' ? Number(m[1]) : 0, x: m && m[2] === 'x' ? Number(m[1]) : 0 });
    }
    return out;
  }

  // The <img> the click was on: the remembered element if it fits, else whichever image shows srcUrl.
  function findImage(target: EventTarget | null, srcUrl?: string): HTMLImageElement | null {
    // The composed path's first entry isn't always an Element (document, window): hence the optional calls.
    const node = target as Partial<Element> | null;
    const fromTarget = target instanceof HTMLImageElement ? target
      : node?.closest?.('picture')?.querySelector('img') || node?.querySelector?.('img') || null;
    if (fromTarget && (!srcUrl || fromTarget.currentSrc === srcUrl || fromTarget.src === srcUrl)) return fromTarget;
    return [...document.images].find((i) => i.currentSrc === srcUrl || i.src === srcUrl) || fromTarget;
  }

  // Ordered candidate URLs, best first. Dedupes; the caller appends srcUrl as the final fallback.
  function candidatesFor(target: EventTarget | null, srcUrl?: string): string[] {
    const img = findImage(target, srcUrl);
    if (!img) return [];
    const entries: SrcsetEntry[] = [];
    for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset']) entries.push(...parseSrcset(img.getAttribute(attr)));
    const picture = img.closest('picture');
    if (picture) {
      for (const source of picture.querySelectorAll('source')) {
        for (const attr of ['srcset', 'data-srcset']) entries.push(...parseSrcset(source.getAttribute(attr)));
      }
    }
    let largest: string | null = null;
    const byW = entries.filter((e) => e.w);
    const byX = entries.filter((e) => e.x);
    if (byW.length) largest = byW.reduce((a, b) => (b.w > a.w ? b : a)).url;
    else if (byX.length) largest = byX.reduce((a, b) => (b.x > a.x ? b : a)).url;

    const lazy = LAZY_ATTRS.map((a) => abs(img.getAttribute(a))).find((u) => u && !u.startsWith('data:'));
    const link = img.closest<HTMLAnchorElement>('a[href]')?.href;
    const linked = link && IMAGE_EXT.test(link) ? abs(link) : null;

    const list = [largest, lazy, linked, abs(img.currentSrc), abs(img.getAttribute('src'))]
      .filter((u): u is string => !!u);
    return [...new Set(list)];
  }

  const PAGE_FETCH_LIMIT = 30 * 1024 * 1024; // bytes; the result travels as a data: URL in a message

  // Fetch from inside the page: same-origin and CORS-enabled images, blob: URLs, cookie-gated files.
  async function pageFetch(url: string): Promise<PageFetchReply> {
    try {
      const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const blob = await res.blob();
      if (!blob.size) return { ok: false, error: 'empty response' };
      if (blob.size > PAGE_FETCH_LIMIT) return { ok: false, error: 'too large to relay' };
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string); // readAsDataURL always yields a string
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      return { ok: true, type: blob.type, dataUrl };
    } catch (e) {
      const err = e as Error; // fetch rejects with a TypeError or the timeout's DOMException
      return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
    }
  }

  // The toast mirrors the app's (src/public/js/ui.js toast + .toast styles): same markup, colours,
  // countdown bar and hover-pause. It lives in a closed shadow root so page CSS can't touch it. The
  // host passes pointer events through; only the toast itself is clickable.
  const TOAST_CSS = `
    :host { all: initial; position: fixed; right: 24px; bottom: 24px; z-index: 2147483647; pointer-events: none;
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .toast { position: relative; overflow: hidden; display: block; padding: 8px 16px 11px; margin: 0; border: 0;
      border-radius: 10px; background: #d6336c; color: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 6px 20px rgba(0,0,0,.25);
      font: inherit; text-align: left; pointer-events: auto; animation: toast-in .18s ease-out; max-width: min(360px, calc(100vw - 48px)); }
    .toast.error { background: #c92a2a; color: #fff; }
    .toast svg { width: 16px; height: 16px; vertical-align: -3px; margin-right: 4px; fill: currentColor; }
    .toast.clickable { cursor: pointer; }
    .toast.clickable:hover { filter: brightness(1.15); }
    .toast .bar { position: absolute; left: 0; bottom: 0; height: 3px; width: 100%; background: currentColor; opacity: .35;
      transform-origin: left; animation: toast-bar var(--toast-ms, 3000ms) linear forwards; }
    .toast:hover .bar { animation-play-state: paused; }
    @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } }
    @keyframes toast-bar { from { transform: scaleX(1); } to { transform: scaleX(0); } }`;

  let toastHost: HTMLElement | null = null;
  function showToast(text: string, ok: boolean, url?: string | null) {
    if (!document.body) return;
    toastHost?.remove();
    const host = toastHost = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const ms = ok ? 2800 : 5000;
    const t = document.createElement(url ? 'button' : 'div');
    t.className = `toast${ok ? '' : ' error'}${url ? ' clickable' : ''}`;
    t.setAttribute('role', 'status');
    t.style.setProperty('--toast-ms', `${ms}ms`);
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = text;
    const bar = document.createElement('span');
    bar.className = 'bar';
    if (!ok) {
      // Same alert-outline path as the app's icons.js (MDI, Apache-2.0).
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16');
      svg.append(path);
      t.append(svg);
    }
    t.append(msg, bar);
    const style = document.createElement('style');
    style.textContent = TOAST_CSS;
    root.append(style, t);

    let timer: number | undefined;
    let left = ms;
    let since = 0;
    const dismiss = () => { clearTimeout(timer); host.remove(); if (toastHost === host) toastHost = null; };
    const start = () => { since = performance.now(); timer = setTimeout(dismiss, left); };
    t.addEventListener('mouseenter', () => { clearTimeout(timer); left -= performance.now() - since; });
    t.addEventListener('mouseleave', start);
    if (url) {
      t.title = 'Open the board';
      t.addEventListener('click', () => { dismiss(); chrome.runtime.sendMessage({ type: 'open', url } satisfies WorkerMessage); });
    }
    document.body.append(host);
    start();
  }

  chrome.runtime.onMessage.addListener((msg: ContentMessage | null | undefined, sender, sendResponse) => {
    if (msg?.type === 'resolve') {
      const reply: ResolveReply = { candidates: candidatesFor(lastTarget, msg.srcUrl), title: document.title };
      sendResponse(reply);
    } else if (msg?.type === 'fetch') {
      pageFetch(msg.url).then(sendResponse);
      return true;
    } else if (msg?.type === 'toast') {
      showToast(msg.text, msg.ok !== false, msg.url);
      sendResponse({ ok: true });
    }
    return undefined;
  });
})();
