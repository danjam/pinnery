import { test, expect, newUser, signIn } from './fixtures.ts';
import { pngBuffer } from '../test/helpers/images.ts';
import { newBoard, upload } from '../test/helpers/pins.ts';

test('shares a board as viewer, then editor', async ({ page, user, server, browser }) => {
  const bob = await newUser(server, 'Bob');
  const board = await newBoard(user.client, 'Shared');
  await upload(user.client, board.id, await pngBuffer({ color: '#123456' }));

  // Alice shares it with Bob as a viewer.
  await page.goto('/');
  await page.locator('.board-tile', { hasText: 'Shared' }).getByRole('button', { name: 'Board menu' }).click();
  await page.getByRole('menu').getByRole('button', { name: 'Share…' }).click();
  const share = page.getByRole('dialog');
  await share.getByPlaceholder('Find someone by name').fill('Bob');
  // The picker masks other people's emails for non-admins.
  await share.locator('.token', { hasText: 'Bob · b***@example.com' }).getByRole('button', { name: 'Viewer' }).click();
  await expect(share.getByRole('combobox', { name: 'Role for Bob' })).toHaveValue('viewer');

  // Bob sees it, can open the pin, but can't add, select or delete.
  const bobContext = await browser.newContext({ baseURL: server.url });
  await signIn(bobContext, server, bob);
  const bobPage = await bobContext.newPage();
  await bobPage.goto('/');
  await expect(bobPage.locator('.board-tile', { hasText: 'Shared' })).toContainText(`shared by ${user.name}`);
  await bobPage.locator('.board-tile', { hasText: 'Shared' }).click();
  await expect(bobPage.locator('.tile')).toHaveCount(1);
  await expect(bobPage.getByRole('button', { name: 'Pin', exact: true })).toHaveCount(0);
  await expect(bobPage.getByRole('button', { name: 'Select' })).toHaveCount(0);
  await bobPage.locator('.tile').first().click();
  await expect(bobPage.getByRole('dialog').getByRole('button', { name: 'Delete' })).toHaveCount(0);

  // Alice makes him an editor; after a reload Bob can add pins.
  await share.getByRole('combobox', { name: 'Role for Bob' }).selectOption('editor');
  await expect(page.getByText('Bob is now an editor')).toBeVisible();
  await bobPage.reload();
  await expect(bobPage.getByRole('button', { name: 'Pin', exact: true }).first()).toBeVisible();

  // And removing him takes the board away.
  await share.getByRole('button', { name: 'Remove Bob' }).click();
  await expect(share.getByText('Only you can see this board.')).toBeVisible();
  await bobPage.goto('/');
  await expect(bobPage.getByRole('heading', { name: 'Create your first board' })).toBeVisible();

  await bobContext.close();
});
