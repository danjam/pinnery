import { test, expect } from './fixtures.ts';

test('creates, renames and deletes a board', async ({ page, user }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'New board' }).first().click();
  await page.getByRole('dialog').getByPlaceholder('Board name').fill('Trips');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  const tile = page.locator('.board-tile', { hasText: 'Trips' });
  await expect(tile).toBeVisible();

  await tile.getByRole('button', { name: 'Board menu' }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('Holidays');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
  const renamed = page.locator('.board-tile', { hasText: 'Holidays' });
  await expect(renamed).toBeVisible();

  await renamed.getByRole('button', { name: 'Board menu' }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Delete board' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { name: 'Create your first board' })).toBeVisible();
  expect((await user.client.get('/api/boards')).body).toEqual([]);
});
