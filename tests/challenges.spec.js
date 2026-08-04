// Ink's challenge screen — reads the shared challenges_today view, writes to
// active_challenges / challenge_logs.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

// The week the stub lives in: Monday 2026-07-27, "today" is Friday 2026-07-31.
// So the strip has four past days, today, and two disabled future days.
function stubChallenges(page, { doneToday = false, extra = {}, weekLogs = [] } = {}) {
  return page.addInitScript(({ done, over, logs }) => {
    window.__sbCalls = [];
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/functions/v1/push-send')) {
        window.__sbCalls.push({ path: 'functions/push-send', method: opts.method || 'GET', body: opts.body || null });
        return new Response(JSON.stringify({ sent: 1 }), { status: 200 });
      }
      if (u.includes('/rest/v1/')) {
        const path = u.split('/rest/v1/')[1];
        window.__sbCalls.push({ path, method: opts.method || 'GET', body: opts.body || null });
        if (path.startsWith('challenges_today')) {
          return new Response(JSON.stringify([{
            id: 'ch1', title: '10 minute brain sesh', remind_at: '07:00:00', days: null,
            start_date: '2026-07-25', day_number: 7, done_today: done, days_done: 5, streak: 3,
            cadence: 'daily', weekdays: [1, 2, 3, 4, 5, 6, 7], week_target: null,
            due_today: true, week_start: '2026-07-27', week_done: 2, today_local: '2026-07-31',
            ...over,
          }]), { status: 200 });
        }
        if (path.startsWith('challenge_logs?select=')) {
          return new Response(JSON.stringify(logs), { status: 200 });
        }
        if (path.startsWith('active_challenges?completed=eq.true')) {
          return new Response(JSON.stringify([{ id: 'old', title: 'Cold Shower', start_date: '2026-05-01', outcome_note: 'kept it' }]), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }
      return new Response('[]', { status: 200 });
    };
  }, { done: doneToday, over: extra, logs: weekLogs });
}

test.beforeEach(async ({ page }) => { await seedSession(page); });

test('a live challenge shows its day, streak and time from the view', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await expect(page.locator('.ch-title')).toHaveText('10 minute brain sesh');
  await expect(page.locator('.ch-day')).toHaveText('Day 7');       // open-ended: no "of N"
  await expect(page.locator('.ch-time')).toHaveText('7:00 AM');
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
  await page.locator('#ch-time').fill('07:00');
  await page.locator('#sheet-primary').click();
  const post = await page.evaluate(() => window.__sbCalls.find((c) => c.path === 'active_challenges' && c.method === 'POST'));
  const body = JSON.parse(post.body);
  expect(body.title).toBe('10 minute brain sesh');
  expect(body.remind_at).toBe('07:00');
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

// ── Cadence: daily, certain weekdays, or a count inside the week ────────────

test('the week strip fills the days already logged and locks the future', async ({ page }) => {
  await stubChallenges(page, {
    weekLogs: [
      { active_challenge_id: 'ch1', date: '2026-07-28' },
      { active_challenge_id: 'ch1', date: '2026-07-29' },
    ],
  });
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  const dots = page.locator('.ch-dot');
  await expect(dots).toHaveCount(7);
  // Mon 27 unlogged, Tue 28 + Wed 29 logged, Fri 31 is today, Sat/Sun future.
  await expect(dots.nth(0)).not.toHaveClass(/\bon\b/);
  await expect(dots.nth(1)).toHaveClass(/\bon\b/);
  await expect(dots.nth(2)).toHaveClass(/\bon\b/);
  await expect(dots.nth(4)).toHaveClass(/\btoday\b/);
  await expect(dots.nth(5)).toBeDisabled();
  await expect(dots.nth(6)).toBeDisabled();
});

test('tapping a past dot backfills that exact day, not today', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await page.locator('.ch-dot').nth(1).click();          // Tuesday
  const post = await page.evaluate(() => window.__sbCalls.find((c) => c.path === 'challenge_logs' && c.method === 'POST'));
  expect(JSON.parse(post.body).date).toBe('2026-07-28');
});

test('tapping a filled dot removes that day', async ({ page }) => {
  await stubChallenges(page, { weekLogs: [{ active_challenge_id: 'ch1', date: '2026-07-28' }] });
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await page.locator('.ch-dot').nth(1).click();
  const del = await page.evaluate(() => window.__sbCalls.find((c) => c.method === 'DELETE' && c.path.startsWith('challenge_logs?')));
  expect(del.path).toContain('date=eq.2026-07-28');
});

test('a rest day is hollow, owes nothing, and does not glow on the home chip', async ({ page }) => {
  // Mon/Wed/Fri gym, but the stub's "today" is a Friday — so make it Mon/Wed only.
  await stubChallenges(page, {
    extra: { title: 'Gym', cadence: 'weekdays', weekdays: [1, 3], due_today: false },
  });
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  const dots = page.locator('.ch-dot');
  await expect(dots.nth(0)).not.toHaveClass(/\boff\b/);   // Mon is scheduled
  await expect(dots.nth(1)).toHaveClass(/\boff\b/);       // Tue is not
  await expect(dots.nth(4)).toHaveClass(/\boff\b/);       // Fri is not
  await expect(page.locator('.ch-check')).toHaveText('Not scheduled today — log anyway');
  await page.evaluate(() => loadActiveChallenge());
  await expect(page.locator('#active-chip')).not.toHaveClass(/open/);
});

test('a times-a-week challenge counts progress instead of a day number', async ({ page }) => {
  await stubChallenges(page, {
    extra: { title: 'Walk', cadence: 'weekly_count', week_target: 4, week_done: 2, streak: 3 },
  });
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await expect(page.locator('.ch-meta')).toContainText('3 week streak');
  await expect(page.locator('.ch-meta')).toContainText('2 of 4 this week');
  await page.evaluate(() => loadActiveChallenge());
  await expect(page.locator('#active-chip-text')).toHaveText('Walk · 2 of 4 this week');
});

test('the form saves the weekdays you picked', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await page.locator('#challenge-new').click();
  await page.locator('#ch-title').fill('Gym');
  await page.locator('#ch-cad button[data-c="weekdays"]').click();
  // Default is Mon-Fri; drop Tue and Thu to leave Mon/Wed/Fri.
  await page.locator('#ch-wd button[data-n="2"]').click();
  await page.locator('#ch-wd button[data-n="4"]').click();
  await page.locator('#sheet-primary').click();
  const post = await page.evaluate(() => window.__sbCalls.find((c) => c.path === 'active_challenges' && c.method === 'POST'));
  const body = JSON.parse(post.body);
  expect(body.cadence).toBe('weekdays');
  expect(body.weekdays).toEqual([1, 3, 5]);
  expect(body.per_week).toBeNull();
});

test('the form saves a times-a-week target', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await page.locator('#challenge-new').click();
  await page.locator('#ch-title').fill('Walk');
  await page.locator('#ch-cad button[data-c="weekly_count"]').click();
  await page.locator('#ch-per').fill('4');
  await page.locator('#sheet-primary').click();
  const post = await page.evaluate(() => window.__sbCalls.find((c) => c.path === 'active_challenges' && c.method === 'POST'));
  const body = JSON.parse(post.body);
  expect(body.cadence).toBe('weekly_count');
  expect(body.per_week).toBe(4);
  expect(body.weekdays).toBeNull();
});

test('a plain daily challenge still saves as daily', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(async () => { navigate('challenges'); await loadChallenges(); });
  await page.locator('#challenge-new').click();
  await page.locator('#ch-title').fill('Walk');
  await page.locator('#ch-days').fill('7');
  await page.locator('#sheet-primary').click();
  const post = await page.evaluate(() => window.__sbCalls.find((c) => c.path === 'active_challenges' && c.method === 'POST'));
  const body = JSON.parse(post.body);
  expect(body.cadence).toBe('daily');
  expect(body.days).toBe(7);
  expect(body.weekdays).toBeNull();
  expect(body.remind_at).toBeNull();   // blank time = no particular hour
});

test('the test notification posts no user_id, so it can only reach your own devices', async ({ page }) => {
  await stubChallenges(page);
  await boot(page);
  await page.evaluate(async () => {
    // Pretend this device is subscribed; the real PushManager needs an
    // installed PWA and a live push service, neither of which exist in CI.
    window.currentPushSub = async () => ({ endpoint: 'https://example.test/sub' });
    await sendTestPush();
  });
  const call = await page.evaluate(() => window.__sbCalls.find((c) => c.path === 'functions/push-send'));
  expect(call.method).toBe('POST');
  const body = JSON.parse(call.body);
  expect(body.user_id).toBeUndefined();   // the function reads it from the JWT
  expect(body.title).toBe('Ink');
  expect(body.tag).toBe('ink-test');
});
