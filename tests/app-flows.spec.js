import { test, expect } from '@playwright/test';
import { boot, seedSession } from './helper.js';

test('manifest theme/background color match the light app background token', async ({ page }) => {
  await boot(page);
  const colors = await page.evaluate(async () => {
    const manifest = await fetch('./manifest.json').then((r) => r.json());
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const meta = document.querySelector('meta[name="theme-color"]')?.content;
    return { bg, meta, manifestTheme: manifest.theme_color, manifestBg: manifest.background_color };
  });

  expect(colors).toEqual({
    bg: '#F0EAD6',
    meta: '#F0EAD6',
    manifestTheme: '#F0EAD6',
    manifestBg: '#F0EAD6',
  });
});

test('extracting a new day log persists extracted_entities after creating the row', async ({ page }) => {
  await seedSession(page);
  await page.addInitScript(() => {
    window.__sbCalls = [];
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      const method = opts.method || 'GET';
      if (u.includes('/functions/v1/claude')) {
        return new Response(JSON.stringify({
          text: JSON.stringify({
            entities: { restaurants: [{ name: "Raoul's", dishes: ['steak frites'], note: 'dinner' }] },
          }),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/rest/v1/')) {
        const path = u.split('/rest/v1/')[1];
        window.__sbCalls.push({ path, method, body: opts.body || null });
        if (path.startsWith('day_logs?date=')) return new Response('[]', { status: 200 });
        if (path === 'entries') return new Response(JSON.stringify([{ id: 'entry-1' }]), { status: 200 });
        if (path === 'day_logs') return new Response(JSON.stringify([{ id: 'day-1', text: "Dinner at Raoul's", date: '2026-06-11' }]), { status: 200 });
        if (path === 'day_logs?id=eq.day-1') return new Response('{}', { status: 200 });
        return new Response('[]', { status: 200 });
      }
      return new Response('[]', { status: 200 });
    };
  });
  await boot(page);

  const calls = await page.evaluate(async () => {
    richSet(document.getElementById('log-text'), "Dinner at Raoul's");
    await extractTodayLog();
    return window.__sbCalls;
  });

  const patch = calls.find((c) => c.path === 'day_logs?id=eq.day-1' && c.method === 'PATCH');
  expect(patch).toBeTruthy();
  expect(JSON.parse(patch.body).extracted_entities.restaurants[0].name).toBe("Raoul's");
});
