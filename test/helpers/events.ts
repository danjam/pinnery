import type { Client } from './server.ts';

// A client's live event stream (GET /api/events, see src/live.ts), read in the background.
//
//   const events = await listen(alice);
//   await events.next((e) => e.type === 'board' && e.id === board.id);   // waits for a matching ping
//   events.close();
//
// `seen` holds every ping so far, in order; `comments` counts comment lines (heartbeats).

export type LiveEvent = { type: 'board'; id: number } | { type: 'boards' };

export interface Listener {
  res: Response;
  seen: LiveEvent[];
  comments: () => number;
  /**
   * Resolves with the first ping matching `match`, looking from `since` (an index into `seen`; by
   * default only pings still to come); rejects after `ms`.
   */
  next: (match: (e: LiveEvent) => boolean, opts?: { ms?: number; since?: number }) => Promise<LiveEvent>;
  /** Resolves once the server ends the stream; rejects after `ms`. */
  ended: (ms?: number) => Promise<void>;
  close: () => void;
}

export const isBoard = (id: number) => (e: LiveEvent) => e.type === 'board' && e.id === id;
export const isBoards = (e: LiveEvent) => e.type === 'boards';

export async function listen(client: Pick<Client, 'fetch'>, headers: Record<string, string> = {}): Promise<Listener> {
  const abort = new AbortController();
  const res = await client.fetch('/api/events', { signal: abort.signal, headers });
  if (res.status !== 200 || !res.body) throw new Error(`event stream failed: ${res.status}`);
  const seen: LiveEvent[] = [];
  let comments = 0;
  let done = false;
  const waiters = new Set<() => void>();
  const wake = () => { for (const w of waiters) w(); };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.startsWith(':')) comments++;
          else if (frame.startsWith('data: ')) seen.push(JSON.parse(frame.slice(6)));
        }
        wake();
      }
    } catch { /* aborted */ }
    done = true;
    wake();
  })();

  // Poll-free waiting: each chunk wakes the waiters, which re-check.
  const until = (ok: () => boolean, ms: number, what: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`timed out after ${ms}ms waiting for ${what}; saw ${JSON.stringify(seen)}`)); }, ms);
    const check = () => {
      if (!ok()) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve();
    };
    waiters.add(check);
    check();
  });

  return {
    res,
    seen,
    comments: () => comments,
    async next(match, { ms = 2000, since = seen.length } = {}) {
      const from = since;
      let found: LiveEvent | undefined;
      await until(() => (found = seen.slice(from).find(match)) !== undefined, ms, 'a matching ping');
      return found!;
    },
    ended: (ms = 2000) => until(() => done, ms, 'the stream to end'),
    close: () => abort.abort(),
  };
}
