// Live updates: the server pings open pages over Server-Sent Events (/api/events, see src/live.ts)
// when a board they show changes. A ping only names what changed; the page refetches through the
// API. Every open calls `resync`: the first, because a write can land between the page's first
// fetch and the stream opening; later ones (EventSource reconnects by itself after a drop),
// because pings sent while it was down are lost.
import { api } from './api.ts';

export type LiveEvent = { type: 'board'; id: number } | { type: 'boards' };

const MAX_RETRY_MS = 60_000;

export function connectLive(onEvent: (e: LiveEvent) => void, resync: () => void) {
  let retryMs = 1000;

  function connect() {
    const source = new EventSource('/api/events');
    source.onopen = () => {
      retryMs = 1000;
      resync();
    };
    source.onmessage = (m) => {
      let e: LiveEvent;
      try { e = JSON.parse(m.data); } catch { return; }
      onEvent(e);
    };
    // EventSource retries a dropped connection itself, but gives up on an error status (a 401, or
    // a proxy's 502 while the server restarts). Then try again, slower each time, once /api/me
    // answers — request() sends a signed-out page to the login page.
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) return;
      source.close();
      const retry = () => {
        setTimeout(() => api.me().then(connect, retry), retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      };
      retry();
    };
  }
  connect();
}
