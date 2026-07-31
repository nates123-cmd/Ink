// Ink's challenge screen — reads the shared challenges_today view, writes to
// active_challenges / challenge_logs.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

function stubChallenges(page, { doneToday = false } = {}) {
  return page.addInitScript((done) => {
    window.__sbCalls = [];
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/v1/')) {
        const path = u.split('/rest/v1/')[1];
        window.__sbCalls.push({ path, method: opts.method || 'GET', body: opts.body || null });
        if (path.startsWith('challenges_today')) {
          return new Response(JSON.stringify([{
            id: 'ch1', title: '10 minute brain sesh', why: 'stop drifting', days: null,
            start_date: '2026-07-25', day_number: 7, done_today: done, days_done: 5, streak: 3,
          }]), { status: 200 });
        }
        if (path.startsWith('active_challenges?completed=eq.true')) {
          return new Response(JSON.stringify([{ id: 'old', title: 'Cold Shower', start_date: '2026-05-01', outcome_note: 'kept it' }]), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }
      return new Response('[]', { status: 200 });
    };
  }, doneToday);
}

test.beforeEach(async ({ page }) => { await seedSession(page); });

test('a live challenge shows its day, streak and reason from the view', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await expect(page.locator('.ch-title')).toHaveText('10 minute brain sesh');
  await expect(page.locator('.ch-day')).toHaveText('Day 7');       // open-ended: no "of N"
  await expect(page.locator('.ch-why')).toHaveText('stop drifting');
  await expect(page.locator('.ch-meta')).toContainText('3 day streak');
  await expect(page.locator('.ch-check')).toHaveText('Mark today done');
  await expect(page.locator('.ch-past')).toContainText('Cold Shower');
});

test('checking in writes one challenge_logs row for today', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await page.locator('.ch-check').click();
  const post = await page.evaluate(() => window.__sbCalls.find((c) => c.path === 'challenge_logs' && c.method === 'POST'));
  expect(JSON.parse(post.body).active_challenge_id).toBe('ch1');
});

test('un-checking deletes the day rather than flipping a flag', async ({ page }) => {
  await stubChallenges(page, { doneToday: true });
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await expect(page.locator('.ch-check')).toHaveText('Done today ✓');
  await page.locator('.ch-check').click();
  const del = await page.evaluate(() => window.__sbCalls.find((c) => c.method === 'DELETE' && c.path.startsWith('challenge_logs?')));
  expect(del.path).toContain('active_challenge_id=eq.ch1');
});

test('a custom challenge can be open-ended', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await page.locator('#challenge-new').click();
  await page.locator('#ch-title').fill('10 minute brain sesh');
  await page.locator('#ch-why').fill('stop drifting');
  await page.locator('#sheet-primary').click();
  const post = await page.evaluate(() => window.__sbCalls.find((c) => c.path === 'active_challenges' && c.method === 'POST'));
  const body = JSON.parse(post.body);
  expect(body.title).toBe('10 minute brain sesh');
  expect(body.days).toBeNull();
  expect(body.completed).toBe(false);
});

test('finishing keeps the record with an outcome note', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await page.locator('.mind-act', { hasText: 'Finish' }).click();
  await page.locator('#ch-note').fill('stuck, mornings are quieter');
  await page.locator('#sheet-primary').click();
  const patch = await page.evaluate(() => window.__sbCalls.find((c) => c.method === 'PATCH' && c.path.startsWith('active_challenges?id=eq.ch1')));
  const body = JSON.parse(patch.body);
  expect(body.completed).toBe(true);
  expect(body.outcome_note).toBe('stuck, mornings are quieter');
});

test('the home chip reads the view and shows whether today is still open', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(() => loadActiveChallenge());
  await expect(page.locator('#active-chip')).toHaveClass(/show/);
  await expect(page.locator('#active-chip-text')).toHaveText('10 minute brain sesh · day 7');
  await expect(page.locator('#active-chip')).toHaveClass(/open/);
});
