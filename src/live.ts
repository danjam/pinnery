import type { Request, Response } from 'express';
import type { Db } from './db.ts';

// Live updates: open pages hold a Server-Sent Events stream (GET /api/events) and the server pings
// them when something they show changes, so they refetch through the API. A ping says only what
// changed, never the data: { type: 'board', id } (that board's name, cover or pins) or
// { type: 'boards' } (the user's list of boards gained or lost one). One process, so the
// connections live in memory.
//
// This module only keeps the streams. Who gets a ping is decided by the caller, through access.ts
// (see notify in routes.ts): a user who can't see a board never hears its id.

export type LiveEvent = { type: 'board'; id: number } | { type: 'boards' };

export type Live = ReturnType<typeof createLive>;

interface Stream {
  userId: number;
  sessionId: number;
  res: Response;
}

// A comment line every so often keeps idle streams open through proxies (Traefik, nginx) that
// drop quiet connections.
const HEARTBEAT_MS = 25_000;

export function createLive(db: Db, { heartbeatMs = HEARTBEAT_MS }: { heartbeatMs?: number } = {}) {
  const streams = new Set<Stream>();
  // A stream outlives the request that opened it, so its session is checked again before each
  // write: signing out, a password change elsewhere, demotion or deletion ends the stream. (The
  // user too: a deleted session's id can be handed out again.)
  const sessionLive = db.prepare<[number, number]>("SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");

  // Write to a stream whose session still stands; otherwise end it.
  function write(s: Stream, chunk: string) {
    if (s.res.destroyed || !sessionLive.get(s.sessionId, s.userId)) {
      s.res.end();
      streams.delete(s);
      return;
    }
    s.res.write(chunk);
  }

  const heartbeat = setInterval(() => {
    for (const s of streams) write(s, ':\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  // GET /api/events, behind requireApi. no-transform keeps compression (server.ts) and proxies
  // from buffering the stream; X-Accel-Buffering does the same for nginx.
  function handler(req: Request, res: Response) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(':\n\n');
    const s: Stream = { userId: req.user.id, sessionId: req.session.id, res };
    streams.add(s);
    // The response's close, not the request's: a GET's request closes as soon as its (empty) body
    // has been read.
    res.on('close', () => streams.delete(s));
  }

  return {
    handler,
    // The users with a stream open: the only ones worth checking access for.
    users: () => new Set([...streams].map((s) => s.userId)),
    send(userIds: Iterable<number>, events: LiveEvent[]) {
      const to = new Set(userIds);
      if (!to.size || !events.length) return;
      const chunk = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      for (const s of streams) if (to.has(s.userId)) write(s, chunk);
    },
    // Shutting down: end every stream so the server can close.
    closeAll() {
      clearInterval(heartbeat);
      for (const s of streams) s.res.end();
      streams.clear();
    },
  };
}
