// What the middleware attaches to a request, declared once for every module: requireApi and
// requirePage (auth.ts) set `session` and `user`; the pick routes (routes.ts) set `pick`.
import type { PublicUser, Session } from './auth.ts';
import type { PendingEntry } from './pending.ts';

declare module 'express-serve-static-core' {
  interface Request {
    session: Session;
    user: PublicUser;
    pick: PendingEntry;
  }
}
