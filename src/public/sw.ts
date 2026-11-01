// Service worker: only here for the Android share target. A share arrives as a POST to /share
// with the image; the worker parks it in a cache and redirects to /share, where the page (signed
// in, same origin) uploads it and opens the board picker. Doing it here rather than on the server
// keeps the image safe if the share lands on the login page first. Nothing else is cached.

// Checked with the WebWorker lib (tsconfig.sw.json), where the global scope is this.
declare const self: ServiceWorkerGlobalScope;

const CACHE = 'pinnery-share';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.origin !== location.origin || url.pathname !== '/share') return;
  e.respondWith((async () => {
    const form = await e.request.formData();
    const file = form.getAll('image').find((f): f is File => f instanceof File && f.size > 0);
    const cache = await caches.open(CACHE);
    // Always park what arrived, even with no image (a shared page sends only a link), so /share
    // can say what it got.
    const meta = {
      title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '',
      fields: [...form.keys()],
    };
    await cache.put('/share/pending', new Response(file || null, { headers: {
      'Content-Type': file ? file.type || 'application/octet-stream' : 'text/plain',
      'X-Share': encodeURIComponent(JSON.stringify(meta)),
      'X-Share-Image': file ? '1' : '0',
    } }));
    return Response.redirect('/share', 303);
  })());
});
