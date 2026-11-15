import { test, expect, newUser } from './fixtures.ts';
import { startServer } from '../test/helpers/server.ts';
import { CLIENT_ID, CLIENT_SECRET, startIdp } from '../test/helpers/idp.ts';

// The only spec that signs in through the form; the others sign in through the API.

test('signs in with the form and out from the menu', async ({ page, server }) => {
  const user = await newUser(server, 'Sam');

  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByPlaceholder('Email').fill(user.email);
  await page.getByPlaceholder('Password').fill('user-password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Create your first board' })).toBeVisible();

  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('shows an error for a wrong password', async ({ page, server }) => {
  const user = await newUser(server, 'Kim');

  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(user.email);
  await page.getByPlaceholder('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#error')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('shows a failed SSO sign-in, and no SSO button when SSO is off', async ({ page }) => {
  await page.goto('/login?error=sso_no_account');
  await expect(page.locator('#error')).toHaveText(/no Pinnery account for that sign-in/);
  await expect(page.locator('#sso')).toBeHidden();
  // Only the known codes show a message.
  await page.goto('/login?error=constructor');
  await expect(page.locator('#error')).toBeHidden();
});

test('signs in with SSO from the button, keeping ?next=', async ({ browser }) => {
  const idp = await startIdp();
  const server = await startServer({
    env: (url) => ({
      PINNERY_PUBLIC_URL: url,
      PINNERY_OIDC_ISSUER: idp.issuer,
      PINNERY_OIDC_CLIENT_ID: CLIENT_ID,
      PINNERY_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      PINNERY_OIDC_NAME: 'Test ID',
    }),
  });
  const page = await browser.newPage({ baseURL: server.url });
  try {
    await server.createUser('sso-user@example.com', 'user-password-1', { displayName: 'Sasha' });
    idp.loginAs({ sub: 'sasha', email: 'sso-user@example.com', email_verified: true });
    await page.goto('/login?next=/settings');
    await page.getByRole('link', { name: 'Sign in with Test ID' }).click();
    await expect(page).toHaveURL(/\/settings$/);
  } finally {
    await page.close();
    await server.stop();
    await idp.close();
  }
});
