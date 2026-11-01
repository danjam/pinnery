import { defineConfig, devices } from '@playwright/test';

// Browser tests for the web app (e2e/*.spec.ts), run with `npm run e2e`. Each worker starts its own
// Pinnery (see e2e/fixtures.ts), so there's no webServer here. Chromium only.
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
