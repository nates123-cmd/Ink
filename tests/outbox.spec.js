// Offline outbox tests — the riskiest, newest subsystem. Every test drives the
// REAL queueWrite/flushOutbox/sbFetch from index.html. We never re-implement the
// queue; we only observe its effects (returned optimistic rows, localStorage,
// and a recorded fetch call log) to pin the documented invariants.
import { test, expect } from '@playwright/test';
import { boot } from './helper.js';
import { OUTBOX_KEY } from './constants.js';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await page.evaluate((k) => localStorage.removeItem(k), OUTBOX_KEY);
});

test.describe('queueWrite — optimistic IDs & collapse', () => {
  test('POST + return=representation mints a UUID and echoes it back', async ({ page }) => {
    const r = await page.evaluate((k) => {
      const optimistic = queueWrite('entries',
        { body: JSON.stringify({ text: 'hello' }), prefer: 'return=representation' }, 'POST');
      const queued = JSON.parse(localStorage.getItem(k));
      const storedId = JSON.parse(queued[0].body).id;
      return { optimistic, storedId };
    }, OUTBOX_KEY);
    expect(Array.isArray(r.optimistic)).toBe(true);
    expect(r.optimistic[0].text).toBe('hello');
    expect(r.optimistic[0].id).toBeTruthy();
    // The id handed back optimistically is the SAME id queued for replay
    // (this is what preserves the parent->child source_entry_id link).
    expect(r.storedId).toBe(r.optimistic[0].id);
  });

  test('a caller-provided id is kept, not overwritten', async ({ page }) => {
    const r = await page.evaluate(() => queueWrite('entries',
      { body: JSON.stringify({ id: 'parent-123', text: 'x' }), prefer: 'return=representation' }, 'POST'));
    expect(r[0].id).toBe('parent-123');
  });

  test('non-representation POST returns null optimistic (caller ignores it)', async ({ page }) => {
    const r = await page.evaluate(() => queueWrite('day_logs',
      { body: JSON.stringify({ a: 1 }) }, 'POST'));
    expect(r).toBeNull();
  });

  test('consecutive PATCHes to the same path collapse; last body wins', async ({ page }) => {
    const r = await page.evaluate((k) => {
      queueWrite('entries?id=eq.1', { body: '{"draft":"a"}' }, 'PATCH');
      queueWrite('entries?id=eq.1', { body: '{"draft":"ab"}' }, 'PATCH');
      queueWrite('entries?id=eq.1', { body: '{"draft":"abc"}' }, 'PATCH');
      const q = JSON.parse(localStorage.getItem(k));
      return { len: q.length, lastBody: q[q.length - 1].body };
    }, OUTBOX_KEY);
    expect(r.len).toBe(1);
    expect(r.lastBody).toBe('{"draft":"abc"}');
  });

  test('PATCH to a DIFFERENT path does NOT collapse', async ({ page }) => {
    const len = await page.evaluate((k) => {
      queueWrite('entries?id=eq.1', { body: '{"d":1}' }, 'PATCH');
      queueWrite('entries?id=eq.2', { body: '{"d":2}' }, 'PATCH');
      return JSON.parse(localStorage.getItem(k)).length;
    }, OUTBOX_KEY);
    expect(len).toBe(2);
  });
});

test.describe('flushOutbox — FIFO replay semantics', () => {
  // Helper: seed the outbox with N ops and install a fetch stub that returns
  // the given status per call (in order) and records the path order. `throwAt`
  // (1-based call index) simulates a network drop instead of an HTTP status.
  const installStub = async (page, ops, statuses, throwAt = 0) => {
    await page.evaluate(({ k, ops, statuses, throwAt }) => {
      localStorage.setItem(k, JSON.stringify(ops));
      window.__calls = [];
      let i = 0;
      window.fetch = async (url) => {
        i += 1;
        window.__calls.push(url);
        if (throwAt && i === throwAt) throw new TypeError('Failed to fetch');
        const status = statuses[i - 1] ?? 200;
        return new Response(status === 204 ? '' : '{}', { status });
      };
    }, { k: OUTBOX_KEY, ops, statuses, throwAt });
  };

  const op = (n, method = 'PATCH') =>
    ({ path: `entries?id=eq.${n}`, method, body: `{"n":${n}}`, prefer: null, ts: n });

  test('drains FIFO in order when all succeed', async ({ page }) => {
    await installStub(page, [op(1), op(2), op(3)], [200, 200, 200]);
    const r = await page.evaluate(async (k) => {
      await flushOutbox();
      return { calls: window.__calls, remaining: JSON.parse(localStorage.getItem(k)).length };
    }, OUTBOX_KEY);
    expect(r.calls.map((u) => u.split('eq.')[1])).toEqual(['1', '2', '3']);
    expect(r.remaining).toBe(0);
  });

  test('a permanently-rejected op (500) is DROPPED, queue still drains', async ({ page }) => {
    await installStub(page, [op(1), op(2), op(3)], [200, 500, 200]);
    const remaining = await page.evaluate(async (k) => {
      await flushOutbox();
      return JSON.parse(localStorage.getItem(k)).length;
    }, OUTBOX_KEY);
    // 500 is dropped (not 404/409), but the op is still shifted so it can't wedge
    // the queue — all three consumed -> empty.
    expect(remaining).toBe(0);
  });

  test('STOPS on a network failure, preserving order for next time', async ({ page }) => {
    // op2 throws (offline mid-flush) -> stop before op3.
    await installStub(page, [op(1), op(2), op(3)], [200, 200, 200], /*throwAt*/ 2);
    const r = await page.evaluate(async (k) => {
      await flushOutbox();
      const q = JSON.parse(localStorage.getItem(k));
      return { callCount: window.__calls.length, remaining: q.length, firstPath: q[0].path };
    }, OUTBOX_KEY);
    expect(r.callCount).toBe(2);        // op3 never attempted
    expect(r.remaining).toBe(2);        // op2 + op3 still queued
    expect(r.firstPath).toBe('entries?id=eq.2'); // order intact (op2 at head)
  });

  test('404 and 409 are treated as already-applied (not dropped-as-error)', async ({ page }) => {
    // Both should be shifted without incrementing the error count -> queue empties.
    await installStub(page, [op(1), op(2)], [404, 409]);
    const remaining = await page.evaluate(async (k) => {
      await flushOutbox();
      return JSON.parse(localStorage.getItem(k)).length;
    }, OUTBOX_KEY);
    expect(remaining).toBe(0);
  });
});

test.describe('sbFetch — offline queueing', () => {
  test('a write while offline is queued without hitting the network', async ({ page, context }) => {
    await context.setOffline(true); // navigator.onLine === false
    const r = await page.evaluate(async (k) => {
      let fetched = false;
      const real = window.fetch;
      window.fetch = async (...a) => { fetched = true; return real(...a); };
      const res = await sbFetch('entries', {
        method: 'POST', body: JSON.stringify({ text: 'offline note' }),
        prefer: 'return=representation',
      });
      const queued = JSON.parse(localStorage.getItem(k) || '[]');
      return { fetched, optimisticId: res?.[0]?.id, queuedLen: queued.length };
    }, OUTBOX_KEY);
    await context.setOffline(false);
    expect(r.fetched).toBe(false);          // skipped the doomed fetch
    expect(r.queuedLen).toBe(1);            // queued instead
    expect(r.optimisticId).toBeTruthy();    // caller still got an optimistic row
  });
});
