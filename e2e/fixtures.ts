import { test as base, expect } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { startServer } from '../test/helpers/server.ts';
import type { Client, Server } from '../test/helpers/server.ts';

// Fixtures for the browser tests. Each worker boots one isolated Pinnery with the same harness as
// the API tests (test/helpers/server.ts), and every page's baseURL points at it, so specs use
// relative paths: page.goto('/').
//
// The URL-fetch guard allows 127.0.0.1, so a spec can pin from a local upstream server.
//
// Sign-in goes through the API (signIn below), not the form: only auth.spec.ts drives /login.
// Failed sign-ins share one throttle per server (see the harness header), and the form is slow.

export interface User {
  client: Client;
  name: string;
  email: string;
}

let count = 0;

// A new account (admin invite + signup), named `name`, with a unique email.
export async function newUser(server: Server, name: string): Promise<User> {
  const email = `${name.toLowerCase()}-${++count}@example.com`;
  const client = await server.createUser(email, 'user-password-1', { displayName: name });
  return { client, name, email };
}

// Give a browser context the user's session cookie.
export async function signIn(context: BrowserContext, server: Server, user: User): Promise<void> {
  const cookie = user.client.cookie();
  if (!cookie) throw new Error(`${user.email} has no session`);
  const value = cookie.slice(cookie.indexOf('=') + 1);
  await context.addCookies([{ name: 'pinnery_session', value, url: server.url }]);
}

export const test = base.extend<{ user: User }, { server: Server }>({
  server: [async ({}, use) => {
    const server = await startServer({ env: { PINNERY_FETCH_ALLOW: '127.0.0.1/32' } });
    await use(server);
    await server.stop();
  }, { scope: 'worker' }],
  baseURL: async ({ server }, use) => use(server.url),
  // A fresh user, signed in on `page`.
  user: async ({ server, context }, use) => {
    const user = await newUser(server, 'Alice');
    await signIn(context, server, user);
    await use(user);
  },
});

export { expect };
