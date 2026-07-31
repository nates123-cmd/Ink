// Rich entry surfaces (notepad-lite) + the Mind "Where to push?" sheet.
import { test, expect } from '@playwright/test';
import { boot, seedSession, stubFetchEmpty } from './helper.js';

test.beforeEach(async ({ page }) => {
  await seedSession(page);
  await stubFetchEmpty(page);
});

test('richDisplay / richPlain round-trip, and plain text survives untouched', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => ({
    plainThrough: richDisplay('two\nlines'),
    escaped: richDisplay('<script>x</script>bad'),
    kept: richDisplay('<b>bold</b> and <ul><li>one</li></ul>'),
    strippedAttrs: richDisplay('<b onclick="x()" style="color:red">b</b>'),
    plainFromHtml: richPlain('<b>a</b><div>b</div><ul><li>c</li></ul>'),
    plainFromPlain: richPlain('just text'),
  }));
  expect(r.plainThrough).toBe('two\nlines');
  expect(r.escaped).not.toContain('<script');
  expect(r.kept).toContain('<b>bold</b>');
  expect(r.kept).toContain('<li>one</li>');
  expect(r.strippedAttrs).toBe('<b>b</b>');
  expect(r.plainFromHtml).toBe('a\nb\n• c');
  expect(r.plainFromPlain).toBe('just text');
});

test('Cmd+B / Cmd+I / Cmd+U format the selection in the capture surface', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => navigate('capture'));
  const box = page.locator('#capture-text');
  await box.click();
  await page.keyboard.type('bolded');
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Meta+B');
  await page.keyboard.press('Meta+I');
  await page.keyboard.press('Meta+U');
  const html = await page.evaluate(() => richGet(document.getElementById('capture-text')));
  expect(html).toMatch(/<b>|<strong>/);
  expect(html).toMatch(/<i>|<em>/);
  expect(html).toContain('<u>');
  expect(await page.evaluate(() => richPlain(richGet(document.getElementById('capture-text'))))).toBe('bolded');
});

test('"- " at the start of a line becomes a bullet list', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => navigate('capture'));
  await page.locator('#capture-text').click();
  await page.keyboard.type('- milk');
  const html = await page.evaluate(() => richGet(document.getElementById('capture-text')));
  expect(html).toContain('<ul>');
  expect(html).toContain('<li>');
  expect(html).not.toContain('- milk');
  expect(await page.evaluate(() => richPlain(richGet(document.getElementById('capture-text'))))).toBe('• milk');
});

test('a bullet list only claims the line it was started on', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => navigate('capture'));
  await page.locator('#capture-text').click();
  await page.keyboard.type('line one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- a');
  await page.keyboard.press('Enter');
  await page.keyboard.type('b');
  const out = await page.evaluate(() => ({
    html: richGet(document.getElementById('capture-text')),
    plain: richPlain(richGet(document.getElementById('capture-text'))),
  }));
  expect(out.html).toContain('<div>line one</div>');
  expect(out.plain).toBe('line one\n• a\n• b');
});

test('legacy plain text round-trips through an editor unescaped', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => navigate('capture'));
  const out = await page.evaluate(() => {
    const el = document.getElementById('capture-text');
    richSet(el, 'a < b & "c"\nsecond line');
    return { plain: richPlain(richGet(el)), shown: el.textContent };
  });
  expect(out.plain).toBe('a < b & "c"\nsecond line');
  expect(out.shown).toContain('a < b & "c"');
});

test('capture saves rich text to thoughts and plain text to entries.raw_text', async ({ page }) => {
  await page.addInitScript(() => {
    window.__sbCalls = [];
    const real = window.fetch;
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/v1/')) {
        const path = u.split('/rest/v1/')[1];
        window.__sbCalls.push({ path, method: opts.method || 'GET', body: opts.body || null });
        if (path === 'entries') return new Response(JSON.stringify([{ id: 'entry-1' }]), { status: 200 });
        if (path === 'thoughts') return new Response(JSON.stringify([{ id: 'th-1' }]), { status: 200 });
        return new Response('[]', { status: 200 });
      }
      return real ? real(url, opts) : new Response('[]', { status: 200 });
    };
  });
  await boot(page);
  const calls = await page.evaluate(async () => {
    navigate('capture');
    richSet(document.getElementById('capture-text'), '<b>Dinner</b> was good');
    updateCaptureCount();
    await saveCapture();
    return window.__sbCalls;
  });
  const entry = calls.find((c) => c.path === 'entries' && c.method === 'POST');
  const thought = calls.find((c) => c.path === 'thoughts' && c.method === 'POST');
  expect(JSON.parse(entry.body).raw_text).toBe('Dinner was good');
  expect(JSON.parse(thought.body).text).toBe('<b>Dinner</b> was good');
});

test('Mind rows carry one arrow, and it opens a "Where to push?" sheet', async ({ page }) => {
  await page.addInitScript(() => {
    window.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/rest/v1/thoughts?')) {
        return new Response(JSON.stringify([
          { id: 't1', text: 'a thought', status: 'active', created_at: '2026-06-11T10:00:00Z', thought_date: '2026-06-11' },
        ]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    };
  });
  await boot(page);
  await page.evaluate(async () => { navigate('mind'); await loadMind(); });
  const acts = await page.locator('#mind-list .mind-item').first().locator('.mind-act');
  await expect(acts.filter({ hasText: '→ Insight' })).toHaveCount(0);
  await expect(acts.filter({ hasText: '→ Mantra' })).toHaveCount(0);
  await expect(page.locator('#mind-list .mind-act.arrow')).toHaveCount(1);
  await page.locator('#mind-list .mind-act.arrow').click();
  await expect(page.locator('#modal-sheet h4')).toHaveText('Where to push?');
  await expect(page.locator('#modal-sheet .push-target')).toHaveCount(2);
  await page.locator('#modal-sheet .push-target', { hasText: 'Mantras' }).click();
  await expect(page.locator('#modal-sheet h4')).toHaveText('Move to Mantras');
});
