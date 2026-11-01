import { test, expect, newUser } from './fixtures.ts';

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
