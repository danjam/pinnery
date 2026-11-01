import { test, expect } from './fixtures.ts';
import { pngBuffer } from '../test/helpers/images.ts';
import { newBoard, rawPost } from '../test/helpers/pins.ts';
import type { User } from './fixtures.ts';

// The extension's save path without the extension: it uploads to /api/pick/upload, then opens
// /pick/<token> for the user to choose a board.

async function park(user: User): Promise<string> {
  const { status, body } = await rawPost(user.client, '/api/pick/upload?source_url=https%3A%2F%2Fexample.com%2Fcat.png&page_title=Cats', await pngBuffer({ color: '#abcdef' }));
  expect(status).toBe(201);
  return body.token;
}

test('pins a parked image to the chosen board', async ({ page, user }) => {
  await newBoard(user.client, 'Other');
  const target = await newBoard(user.client, 'Cats');
  const token = await park(user);

  await page.goto(`/pick/${token}`);
  await expect(page.locator('#caption')).toContainText('Cats');
  await page.getByPlaceholder('Choose a board…').fill('cat');
  // The match, then "Create “cat”" (not an exact name); the first row is selected.
  await expect(page.getByRole('option')).toHaveCount(2);
  await expect(page.getByRole('option', { selected: true })).toContainText('Cats');
  await page.locator('#pin').click();

  await expect(page).toHaveURL(new RegExp(`/pick/${token}/done`));
  await expect(page.getByText('Pinned to “Cats”')).toBeVisible();
  const { body } = await user.client.get(`/api/boards/${target.id}/pins`);
  expect(body.pins).toHaveLength(1);
  expect(body.pins[0].source_url).toBe('https://example.com/cat.png');
});

test('creates a board from the picker and pins to it', async ({ page, user }) => {
  const token = await park(user);

  await page.goto(`/pick/${token}`);
  await page.getByPlaceholder('Choose a board…').fill('Dogs');
  await expect(page.getByRole('option', { name: 'Create “Dogs”' })).toBeVisible();
  await page.getByRole('button', { name: 'Create and pin' }).click();

  await expect(page).toHaveURL(new RegExp(`/pick/${token}/done`));
  const { body: boards } = await user.client.get('/api/boards');
  expect(boards.map((b: { name: string }) => b.name)).toEqual(['Dogs']);
  expect(boards[0].pin_count).toBe(1);
});

test('the token works once', async ({ page, user }) => {
  await newBoard(user.client, 'Once');
  const token = await park(user);

  await page.goto(`/pick/${token}`);
  await page.locator('#pin').click();
  await expect(page).toHaveURL(new RegExp(`/pick/${token}/done`));

  await page.goto(`/pick/${token}`);
  await expect(page.locator('#notice')).toBeVisible();
  await expect(page.locator('#pin')).toBeDisabled();
});
