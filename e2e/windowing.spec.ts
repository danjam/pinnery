import { test, expect } from './fixtures.ts';
import type { Page } from '@playwright/test';
import type { User } from './fixtures.ts';
import type { Server } from '../test/helpers/server.ts';
import { pngBuffer } from '../test/helpers/images.ts';
import { newBoard, upload, clonePins } from '../test/helpers/pins.ts';

// A big board only mounts the tiles near the viewport (app.ts, updateWindow).

const TOTAL = 500;

// A board of TOTAL pins in a few shapes, open in `page`. Returns its pins in display order
// (newest first) and their ids.
async function bigBoard(page: Page, server: Server, user: User) {
  const board = await newBoard(user.client, 'Big');
  const shapes = [[64, 64, '#ff0000'], [64, 128, '#00ff00'], [128, 64, '#0000ff'], [64, 160, '#ffff00']] as const;
  for (const [width, height, color] of shapes) await upload(user.client, board.id, await pngBuffer({ width, height, color }));
  clonePins(server, board.id, TOTAL);
  const pins: { id: number; sha256: string }[] = (await user.client.get(`/api/boards/${board.id}/pins`)).body.pins;
  await page.goto(`/b/${board.id}`);
  await expect(page.locator('#title .count').first()).toHaveText(`(${TOTAL})`);
  return { pins, ids: pins.map((p) => p.id) };
}

// Strings, since this tsconfig has no DOM lib.
const toBottom = (page: Page) => page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
const toTop = (page: Page) => page.evaluate('window.scrollTo(0, 0)');
const tileFor = (page: Page, id: number) => page.locator(`.tile[data-id="${id}"]`);

test('mounts only the tiles near the viewport', async ({ page, server, user }) => {
  const { ids } = await bigBoard(page, server, user);
  const tiles = page.locator('.grid .tile');
  await expect(tileFor(page, ids[0])).toBeVisible();
  const mounted = await tiles.count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(TOTAL / 4);
  await expect(tileFor(page, ids.at(-1)!)).toHaveCount(0);

  // The far end mounts on the way down, and the top unmounts.
  await toBottom(page);
  await expect(tileFor(page, ids.at(-1)!)).toBeVisible();
  await expect(tileFor(page, ids[0])).toHaveCount(0);
  expect(await tiles.count()).toBeLessThan(TOTAL / 4);

  // A narrower window relays out, and the window follows.
  await page.setViewportSize({ width: 600, height: 720 });
  await toTop(page);
  await expect(tileFor(page, ids[0])).toBeVisible();
  expect(await tiles.count()).toBeLessThan(TOTAL / 4);
});

test('selection survives a tile scrolling away and back', async ({ page, server, user }) => {
  const { ids } = await bigBoard(page, server, user);
  await page.getByRole('button', { name: 'Select' }).click();
  await tileFor(page, ids[0]).click();

  await toBottom(page);
  await expect(tileFor(page, ids[0])).toHaveCount(0);
  await tileFor(page, ids.at(-1)!).click();
  await expect(page.locator('#selectcount')).toHaveText('2 selected');

  await toTop(page);
  await expect(tileFor(page, ids[0])).toHaveClass(/\bselected\b/);
  await expect(tileFor(page, ids[1])).not.toHaveClass(/\bselected\b/);
});

test('the lightbox steps through pins that are not mounted', async ({ page, server, user }) => {
  const { pins, ids } = await bigBoard(page, server, user);
  await expect(tileFor(page, ids.at(-1)!)).toHaveCount(0);
  await tileFor(page, ids[0]).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.counter')).toHaveText(`1 / ${TOTAL}`);
  // Back from the first wraps round to the last pin, far below the mounted tiles.
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.locator('.counter')).toHaveText(`${TOTAL} / ${TOTAL}`);
  await expect(dialog.locator('.stage img')).toHaveAttribute('src', `/i/${pins.at(-1)!.sha256}`);
});

test('a live update reaches a big board', async ({ page, server, user }) => {
  const { ids } = await bigBoard(page, server, user);
  // Delete a pin far down the board, out of the DOM.
  const { status } = await user.client.json('/api/pins/delete', { method: 'POST', json: { ids: [ids.at(-1)] } });
  expect(status).toBe(200);
  await expect(page.locator('#title .count').first()).toHaveText(`(${TOTAL - 1})`);
  await toBottom(page);
  await expect(tileFor(page, ids.at(-2)!)).toBeVisible();
  await expect(tileFor(page, ids.at(-1)!)).toHaveCount(0);
});
