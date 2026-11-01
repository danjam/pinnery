import type { Db } from './db.ts';
import type { Mailer } from './mail.ts';
import { createAccount } from './auth/account.ts';
import { createConnect } from './auth/connect.ts';
import { createCore } from './auth/core.ts';
import { createEmailChange } from './auth/email-change.ts';
import { createInvites } from './auth/invites.ts';
import { createLinks } from './auth/links.ts';
import { createReset } from './auth/reset.ts';
import { seedAdmin } from './auth/seed.ts';

// Accounts, sessions and API tokens. The pieces live in auth/:
//   seed.ts          the seeded admin, and resetting it when PINNERY_PASSWORD changes
//   core.ts          user lookups, sessions, tokens and the failure counters the others share
//   links.ts         emailed links (invites, resets, email changes)
//   account.ts       sign-in, password, /api/me, API tokens, and the requireApi/requirePage middleware
//   invites.ts       invites and signup
//   reset.ts         forgotten password, and admins' reset links
//   email-change.ts  changing the sign-in email
//   connect.ts       the extension's connect flow
//   util.ts          hashing, cookies, safeNext and other pure helpers
export { safeNext, linkBase, sameOrigin, COOKIE } from './auth/util.ts';
export type { LinkKind, PublicUser, Session } from './auth/util.ts';
export { parseConnectParams } from './auth/connect.ts';
export type { ConnectParams } from './auth/connect.ts';

// mailer: see mail.ts (may be disabled). publicUrl: PINNERY_PUBLIC_URL, the base of emailed links;
// without it the request's own origin is used.
export interface AuthOptions {
  password?: string;
  adminEmail?: string;
  mailer: Mailer;
  publicUrl?: string;
}

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(db: Db, { password, adminEmail, mailer, publicUrl = '' }: AuthOptions) {
  if (!password || !adminEmail) throw new Error('PINNERY_ADMIN_EMAIL and PINNERY_PASSWORD are required');
  seedAdmin(db, password, adminEmail);
  const core = createCore(db);
  const links = createLinks(db, core, { mailer, publicUrl });
  return {
    ...createAccount(db, core, links),
    ...createInvites(db, core, links, mailer),
    ...createReset(db, core, links, { mailer, publicUrl }),
    ...createEmailChange(db, core, links, mailer),
    ...createConnect(core),
  };
}
