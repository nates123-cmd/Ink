// Fear Setting — guided one-prompt-at-a-time flow with an opt-in read at the end.
import { test, expect } from '@playwright/test';
import { boot, seedSession, stubFetchEmpty } from './helper.js';

test.beforeEach(async ({ page }) => {
  await seedSession(page);
  await page.addInitScript(() => localStorage.removeItem('ink_fear_draft'));
});

test('the Stoic screen offers Fear Setting and it opens its own guided screen', async ({ page }) => {
  await stubFetchEmpty(page);
  await boot(page);
  await page.evaluate(() => navigate('stoic'));
  await page.locator('.stoic-type-btn', { hasText: 'Fear Setting' }).click();
  await expect(page.locator('#screen-fear')).toHaveClass(/active/);
  await expect(page.locator('.fear-q')).toHaveText('What if I…?');
  await expect(page.locator('.fear-step')).toHaveText('Step 1 of 9');
});

test('one prompt is shown at a time and answers survive going back', async ({ page }) => {
  await stubFetchEmpty(page);
  await boot(page);
  await page.evaluate(() => navigate('fear'));
  await expect(page.locator('.fear-q')).toHaveCount(1);
  await page.locator('#fear-a').click();
  await page.keyboard.type('quit the safe job');
  await page.locator('#fear-next').click();
  await expect(page.locator('.fear-q')).toHaveText('Define the worst.');
  await page.locator('#fear-prev').click();
  await expect(page.locator('.fear-q')).toHaveText('What if I…?');
  await expect(page.locator('#fear-a')).toHaveText('quit the safe job');
});

test('a part-finished exercise is still there after leaving the screen', async ({ page }) => {
  await stubFetchEmpty(page);
  await boot(page);
  await page.evaluate(() => navigate('fear'));
  await page.locator('#fear-a').click();
  await page.keyboard.type('the conversation I keep dodging');
  await page.locator('#fear-next').click();
  await page.evaluate(() => goBack());
  await page.waitForTimeout(400);  // slideTo() drops calls made mid-transition
  await page.evaluate(() => navigate('fear'));
  await expect(page.locator('#screen-fear')).toHaveClass(/active/);
  await expect(page.locator('.fear-step')).toHaveText('Step 2 of 9');
  await page.locator('#fear-prev').click();
  await expect(page.locator('#fear-a')).toHaveText('the conversation I keep dodging');
});

test('review lists what was written, and the read is opt-in', async ({ page }) => {
  await stubFetchEmpty(page);
  await boot(page);
  await page.evaluate(() => {
    navigate('fear');
    fearAns[0] = 'quit the safe job';
    fearAns[6] = 'six more months of quiet resentment';
    fearIdx = FEAR_STEPS.length;
    renderFear();
  });
  await expect(page.locator('.fear-review-a')).toHaveText(['quit the safe job', 'six more months of quiet resentment']);
  // no model call happens on its own
  await expect(page.locator('.fear-read')).toHaveCount(0);
  await expect(page.locator('#fear-ai')).toHaveText('Ask for a read');
});

test('the read appends to the saved reflection, tagged fear-setting', async ({ page }) => {
  await page.addInitScript(() => {
    window.__sbCalls = [];
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/v1/')) {
        const path = u.split('/rest/v1/')[1];
        window.__sbCalls.push({ path, method: opts.method || 'GET', body: opts.body || null });
        if (path === 'entries') return new Response(JSON.stringify([{ id: 'e1' }]), { status: 200 });
        return new Response('[]', { status: 200 });
      }
      return new Response('[]', { status: 200 });
    };
  });
  await boot(page);
  await page.evaluate(async () => {
    navigate('fear');
    fearAns[0] = 'quit the safe job';
    fearRead = 'The worst case is a year of savings, not ruin.';
    fearIdx = FEAR_STEPS.length;
    renderFear();
    await saveFear();
  });
  const refl = await page.evaluate(() => window.__sbCalls.find((c) => c.path === 'reflections' && c.method === 'POST'));
  const body = JSON.parse(refl.body);
  expect(body.prompt_used).toBe('Fear Setting');
  expect(body.tags).toContain('fear-setting');
  expect(body.text).toContain('Q: What if I…?');
  expect(body.text).toContain('The worst case is a year of savings, not ruin.');
  // saving clears the draft so the next run starts clean
  expect(await page.evaluate(() => localStorage.getItem('ink_fear_draft'))).toBeNull();
});
