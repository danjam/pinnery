import type { Page } from '@playwright/test';
import { test, expect, newUser, signIn } from './fixtures.ts';
import { pngBuffer } from '../test/helpers/images.ts';
import { newBoard, upload } from '../test/helpers/pins.ts';

// Live updates: open pages follow changes made elsewhere without a reload (src/live.ts,
// js/live.ts). Each page is opened only once its event stream is up, so no ping can come before it.
async function open(page: Page, path: string) {
  const streaming = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/events');
  await page.goto(path);
  await streaming;
}

test('a change in one tab shows up in another', async ({ page, user, context }) => {
  const other = await context.newPage();
  await open(page, '/');
  await open(other, '/');

  // A board made in one tab appears on the other's home page.
  await page.getByRole('button', { name: 'New board' }).first().click();
  await page.getByRole('dialog').getByPlaceholder('Board name').fill('Live');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(other.locator('.board-tile', { hasText: 'Live' })).toBeVisible();

  // Both open it; a pin added elsewhere (here the API, as the extension would) shows in both.
  await other.locator('.board-tile', { hasText: 'Live' }).click();
  const id = Number(new URL(other.url()).pathname.split('/').pop());
  await open(page, `/b/${id}`);
  await upload(user.client, id, await pngBuffer({ color: '#ab12cd' }));
  await expect(page.locator('.tile')).toHaveCount(1);
  await expect(other.locator('.tile')).toHaveCount(1);

  // Deleting it in one tab removes it from the other, and a rename changes its title.
  await page.locator('.tile').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Delete' }).click();
  await expect(other.locator('.tile')).toHaveCount(0);
  await user.client.patch(`/api/boards/${id}`, { name: 'Still live' });
  await expect(other.locator('#title .crumb')).toHaveText('Still live');
});

test('losing a shared board takes its open page home', async ({ user, server, browser }) => {
  const lenny = await newUser(server, 'Lenny');
  const lennyId = (await lenny.client.get('/api/me')).body.id;
  const board = await newBoard(user.client, 'Lent');
  await upload(user.client, board.id, await pngBuffer({ color: '#2468ac' }));

  const lennyContext = await browser.newContext({ baseURL: server.url });
  await signIn(lennyContext, server, lenny);
  const lennyPage = await lennyContext.newPage();
  await open(lennyPage, '/');

  // Shared with Lenny: it appears on their home page.
  await user.client.json(`/api/boards/${board.id}/shares/${lennyId}`, { method: 'PUT', json: { role: 'viewer' } });
  await lennyPage.locator('.board-tile', { hasText: 'Lent' }).click();
  await expect(lennyPage.locator('.tile')).toHaveCount(1);

  // Made an editor: their open page offers + Pin.
  await expect(lennyPage.getByRole('button', { name: 'Pin', exact: true })).toHaveCount(0);
  await user.client.json(`/api/boards/${board.id}/shares/${lennyId}`, { method: 'PUT', json: { role: 'editor' } });
  await expect(lennyPage.getByRole('button', { name: 'Pin', exact: true }).first()).toBeVisible();

  // Unshared: their open page goes home.
  await user.client.del(`/api/boards/${board.id}/shares/${lennyId}`);
  await expect(lennyPage).toHaveURL(/\/$/);
  await expect(lennyPage.getByText('That board is no longer available')).toBeVisible();
  await expect(lennyPage.locator('.board-tile', { hasText: 'Lent' })).toHaveCount(0);

  await lennyContext.close();
});

test('a change made while the stream is still opening is not missed', async ({ page, user }) => {
  const board = await newBoard(user.client, 'Gap');
  // Hold the event stream back until the page has drawn the board, then add a pin before letting
  // it through: no ping can reach the page, so only the resync on first open can show the pin.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/events', async (route) => { await held; await route.continue(); });
  const pinsLoaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/boards/${board.id}/pins`);
  await page.goto(`/b/${board.id}`);
  await pinsLoaded;
  await expect(page.getByRole('heading', { name: 'No pins yet' })).toBeVisible();

  await upload(user.client, board.id, await pngBuffer({ color: '#12abcd' }));
  release();
  await expect(page.locator('.tile')).toHaveCount(1);
});
