// Boot smoke tests — guards that the page script runs clean and routes to the
// right first screen based on session state.
import { test, expect } from '@playwright/test';
import { boot, seedSession, stubFetchEmpty } from './helper.js';

test('title is "Ink" and globals are defined after boot', async ({ page }) => {
  await boot(page);
  await expect(page).toHaveTitle('Ink');
  const defined = await page.evaluate(() => ['toRoman', 'esc', 'queueWrite',
    'flushOutbox', 'sbFetch', 'resolveSolar', 'applyTheme']
    .every((f) => typeof window[f] === 'function'));
  expect(defined).toBe(true);
});

test('no session -> OTP gate is the active screen', async ({ page }) => {
  // No seeded session: boot should land on the auth gate, not home.
  await boot(page);
  await expect(page.locator('#screen-otp')).toHaveClass(/active/);
  await expect(page.locator('#screen-home')).not.toHaveClass(/active/);
});

test('valid session -> home is the active screen (no gate)', async ({ page }) => {
  await seedSession(page);
  await stubFetchEmpty(page); // neutralise the entries fetch enterApp() kicks off
  await boot(page);
  await expect(page.locator('#screen-home')).toHaveClass(/active/);
  await expect(page.locator('#screen-otp')).not.toHaveClass(/active/);
});

test('boot throws no uncaught page errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await seedSession(page);
  await stubFetchEmpty(page);
  await boot(page);
  // give any deferred boot work a tick to surface
  await page.waitForTimeout(250);
  expect(errors).toEqual([]);
});
