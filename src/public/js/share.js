// Android share target, step 2. The service worker (sw.js) parked the shared image in a cache and
// sent us here; upload it as a pending pick and hand over to the board picker (/pick/<token>).

import { el } from './ui.js';

const CACHE = 'pinnery-share';
const text = document.getElementById('notice-text');
const actions = document.getElementById('notice-actions');

function stop(message) {
  text.textContent = message;
  actions.replaceChildren(el('a', { class: 'btn primary', href: '/', text: 'Open Pinnery' }));
}

async function run() {
  const cache = await caches.open(CACHE);
  const res = await cache.match('/share/pending');
  if (!res) return stop('Nothing to pin. Share an image to Pinnery from another app.');
  let meta = {};
  try { meta = JSON.parse(decodeURIComponent(res.headers.get('X-Share') || '')); } catch {}
  // Apps put the source link in `url` or, often, in `text`.
  const link = [meta.url, meta.text].map((s) => (s || '').trim()).find((s) => /^https?:\/\/\S+$/i.test(s)) || '';
  if (res.headers.get('X-Share-Image') !== '1') {
    await cache.delete('/share/pending');
    return stop(link
      ? 'That shared a link, not an image. On the page, long-press the image → “Download image”, then share it to Pinnery from your gallery.'
      : `No image arrived (got: ${(meta.fields || []).join(', ') || 'nothing'}).`);
  }
  const q = new URLSearchParams();
  if (link) q.set('source_url', link);
  if (meta.title) q.set('page_title', meta.title);
  text.textContent = 'Uploading…';
  const up = await fetch(`/api/pick/upload?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' },
    body: await res.blob(),
  });
  const body = await up.json().catch(() => ({}));
  if (!up.ok) return stop(`Couldn't upload: ${body.error || up.status}`);
  await cache.delete('/share/pending');
  location.replace(`/pick/${body.token}`);
}

run().catch((e) => stop(`Couldn't share: ${e.message}`));
