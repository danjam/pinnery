import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from './fixtures.ts';
import { pngBuffer } from '../test/helpers/images.ts';
import { newBoard, upload } from '../test/helpers/pins.ts';

test('adds a pin by upload', async ({ page, user }) => {
  const board = await newBoard(user.client, 'Uploads');
  await page.goto(`/b/${board.id}`);

  await page.getByRole('button', { name: 'Pin', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type=file]').setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: await pngBuffer({ color: '#ff0000' }) });
  await expect(dialog.getByText('added')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();

  await expect(page.locator('.tile')).toHaveCount(1);
  await expect(page.locator('#title .count').first()).toHaveText('(1)');
});

test('adds a pin by URL', async ({ page, user }) => {
  const png = await pngBuffer({ color: '#00ff00' });
  const upstream = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(png));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/green.png`;
    const board = await newBoard(user.client, 'Links');
    await page.goto(`/b/${board.id}`);

    await page.getByRole('button', { name: 'Pin', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Paste an image URL').fill(url);
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog.getByText('added')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();

    await expect(page.locator('.tile')).toHaveCount(1);
    const { body } = await user.client.get(`/api/boards/${board.id}/pins`);
    expect(body.pins[0].source_url).toBe(url);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('moves pins to another board with select', async ({ page, user }) => {
  const from = await newBoard(user.client, 'From');
  const to = await newBoard(user.client, 'To');
  await upload(user.client, from.id, await pngBuffer({ color: '#0000ff' }));
  await upload(user.client, from.id, await pngBuffer({ color: '#ffff00' }));
  await page.goto(`/b/${from.id}`);

  await page.getByRole('button', { name: 'Select' }).click();
  const tiles = page.locator('.tile');
  await tiles.nth(0).click();
  await tiles.nth(1).click();
  await expect(page.locator('#selectcount')).toHaveText('2 selected');
  await page.locator('#sel-move').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox').selectOption({ label: 'To' });
  await dialog.getByRole('button', { name: 'Move' }).click();

  await expect(tiles).toHaveCount(0);
  const { body } = await user.client.get(`/api/boards/${to.id}/pins`);
  expect(body.pins).toHaveLength(2);
});

test('deletes a pin from the lightbox', async ({ page, user }) => {
  const board = await newBoard(user.client, 'Doomed');
  await upload(user.client, board.id, await pngBuffer({ color: '#ff00ff' }));
  await page.goto(`/b/${board.id}`);

  await page.locator('.tile').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  // The confirm opens on top of the lightbox.
  await page.getByRole('dialog').last().getByRole('button', { name: 'Delete' }).click();

  await expect(page.getByRole('heading', { name: 'No pins yet' })).toBeVisible();
  const { body } = await user.client.get(`/api/boards/${board.id}/pins`);
  expect(body.pins).toEqual([]);
});

test('the lightbox fits a tall image on screen', async ({ page, user }) => {
  await page.setViewportSize({ width: 3440, height: 1440 });
  const board = await newBoard(user.client, 'Tall');
  await upload(user.client, board.id, await pngBuffer({ width: 1000, height: 3000 }));
  await page.goto(`/b/${board.id}`);

  await page.locator('.tile').first().click();
  const img = page.getByRole('dialog').locator('.stage img');
  await expect(img).toHaveJSProperty('complete', true);
  const box = await img.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(1440);
});

test('the lightbox only links http(s) sources', async ({ page, user }) => {
  const board = await newBoard(user.client, 'Legacy');
  await upload(user.client, board.id, await pngBuffer({ color: '#00ffff' }), '&name=Old%20pin');
  // A value saved before source URLs were checked.
  await page.route(`**/api/boards/${board.id}/pins*`, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.pins[0].source_url = 'javascript:alert(1)';
    await route.fulfill({ response: res, json });
  });
  await page.goto(`/b/${board.id}`);

  await page.locator('.tile').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Old pin')).toBeVisible();
  await expect(dialog.locator('a[href^="javascript:"]')).toHaveCount(0);
});
