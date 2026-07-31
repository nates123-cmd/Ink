// Mind as one flat, badged stream + filing as the triage step.
import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

// Two thoughts, one insight, one mantra, interleaved by created_at, plus one
// flat collection shared across the types.
function stubMind(page, { status = 'active' } = {}) {
  return page.addInitScript((wanted) => {
    window.__sbCalls = [];
    const rows = {
      thoughts: [
        { id: 't1', text: 'thought one', status: wanted, created_at: '2026-06-14T10:00:00Z', thought_date: '2026-06-14', collection_id: 'c1' },
        { id: 't2', text: 'thought two', status: wanted, created_at: '2026-06-10T10:00:00Z', thought_date: '2026-06-10' },
      ],
      insights: [{ id: 'i1', text: 'an insight', status: wanted, created_at: '2026-06-12T10:00:00Z', collection_id: 'c1' }],
      mantras: [{ id: 'm1', text: 'a mantra', status: wanted, created_at: '2026-06-13T10:00:00Z' }],
    };
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/v1/')) {
        const path = u.split('/rest/v1/')[1];
        window.__sbCalls.push({ path, method: opts.method || 'GET', body: opts.body || null });
        if (path.startsWith('collections')) return new Response(JSON.stringify([{ id: 'c1', name: 'Learning Habits', entry_type: 'any' }]), { status: 200 });
        for (const t of ['thoughts', 'insights', 'mantras']) {
          if (path.startsWith(t + '?')) {
            const want = (path.match(/status=eq\.(\w+)/) || [])[1];
            const col = (path.match(/collection_id=eq\.([\w-]+)/) || [])[1];
            let out = rows[t].filter((r) => r.status === want);
            if (col) out = out.filter((r) => r.collection_id === col);
            return new Response(JSON.stringify(out), { status: 200 });
          }
        }
        return new Response('[]', { status: 200 });
      }
      return new Response('[]', { status: 200 });
    };
  }, status);
}

test.beforeEach(async ({ page }) => { await seedSession(page); });

test('all three types share one list, newest first, each badged', async ({ page }) => {
  await stubMind(page);
  await boot(page);
  await page.evaluate(async () => { navigate('mind'); await loadMind(); });
  const items = page.locator('#mind-list .mind-item');
  await expect(items).toHaveCount(4);
  // newest first: thought(6/14) · mantra(6/13) · insight(6/12) · thought(6/10)
  await expect(items.locator('.badge.kind')).toHaveText(['Thought', 'Mantra', 'Insight', 'Thought']);
  await expect(page.locator('#mind-list .mind-text').first()).toHaveText('thought one');
});

test('the type chips filter the one list instead of switching screens', async ({ page }) => {
  await stubMind(page);
  await boot(page);
  await page.evaluate(async () => { navigate('mind'); await loadMind(); });
  await expect(page.locator('#mind-tabs .mind-tab')).toHaveText(['All', 'Thoughts', 'Insights', 'Mantras']);
  await expect(page.locator('#mind-tabs .mind-tab.active')).toHaveText('All');
  await page.locator('#mind-tabs .mind-tab', { hasText: 'Insights' }).click();
  await expect(page.locator('#mind-list .mind-item')).toHaveCount(1);
  await expect(page.locator('#mind-list .badge.kind')).toHaveText('Insight');
});

test('a collection filter spans types — no flipping between groups', async ({ page }) => {
  await stubMind(page);
  await boot(page);
  await page.evaluate(async () => { navigate('mind'); mindColFilter = 'c1'; await loadMind(); });
  const items = page.locator('#mind-list .mind-item');
  await expect(items).toHaveCount(2);
  await expect(items.locator('.badge.kind')).toHaveText(['Thought', 'Insight']);
  // one flat collections read, not one per type
  const colCalls = await page.evaluate(() => window.__sbCalls.filter((c) => c.path.startsWith('collections')));
  expect(colCalls.every((c) => !c.path.includes('entry_type'))).toBe(true);
});

test('File replaces Dismiss and files into a collection in one step', async ({ page }) => {
  await stubMind(page);
  await boot(page);
  await page.evaluate(async () => { navigate('mind'); await loadMind(); });
  const acts = page.locator('#mind-list .mind-item').first().locator('.mind-act');
  await expect(acts.filter({ hasText: 'Dismiss' })).toHaveCount(0);
  await acts.filter({ hasText: 'File' }).click();
  await expect(page.locator('#modal-sheet h4')).toHaveText('File it');
  await page.locator('#modal-sheet .sheet-row', { hasText: 'Learning Habits' }).click();
  const patch = await page.evaluate(() => window.__sbCalls.find((c) => c.method === 'PATCH' && c.path.startsWith('thoughts?id=eq.t1')));
  expect(JSON.parse(patch.body).status).toBe('dismissed');
});

test('filed items live behind the Filed toggle and can be unfiled', async ({ page }) => {
  await stubMind(page, { status: 'dismissed' });
  await boot(page);
  await page.evaluate(async () => { navigate('mind'); await loadMind(); });
  await expect(page.locator('#mind-list .mind-item')).toHaveCount(0);
  await page.locator('#mind-toggle').click();
  await expect(page.locator('#mind-list .mind-item')).toHaveCount(4);
  await expect(page.locator('#mind-count')).toContainText('filed');
  await page.locator('#mind-list .mind-item').first().locator('.mind-act', { hasText: 'Unfile' }).click();
  const patch = await page.evaluate(() => window.__sbCalls.find((c) => c.method === 'PATCH' && c.path.startsWith('thoughts?id=eq.t1')));
  expect(JSON.parse(patch.body).status).toBe('active');
});
