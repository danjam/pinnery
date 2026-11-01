import fs from 'node:fs';
import { test, expect } from './fixtures.ts';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the version in Settings links to the repo', async ({ page, user: _user }) => {
  // Requesting `user` signs the page in.
  await page.goto('/settings');
  const link = page.locator('.settings-footer a');
  await expect(link).toHaveText(`Pinnery v${version}`);
  await expect(link).toHaveAttribute('href', 'https://github.com/danjam/pinnery');
  await expect(link).toHaveAttribute('target', '_blank');
});
