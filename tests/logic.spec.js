// Pure-logic tests. Every assertion calls the REAL global function from
// index.html via page.evaluate — no re-implementation, so a regression in the
// shipped code fails the test.
import { test, expect } from '@playwright/test';
import { boot } from './helper.js';

test.beforeEach(async ({ page }) => { await boot(page); });

test.describe('toRoman', () => {
  const cases = [[1, 'I'], [4, 'IV'], [9, 'IX'], [40, 'XL'], [90, 'XC'],
                 [2026, 'MMXXVI'], [1994, 'MCMXCIV'], [0, '']];
  for (const [n, expected] of cases) {
    test(`toRoman(${n}) === "${expected}"`, async ({ page }) => {
      expect(await page.evaluate((x) => toRoman(x), n)).toBe(expected);
    });
  }
});

test.describe('esc (XSS escaping)', () => {
  test('escapes the dangerous five', async ({ page }) => {
    const out = await page.evaluate(() => esc('<img src=x onerror="alert(1)">&\'"'));
    expect(out).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;\'&quot;');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });
  test('null/undefined become empty string (no "null" leak)', async ({ page }) => {
    expect(await page.evaluate(() => esc(null))).toBe('');
    expect(await page.evaluate(() => esc(undefined))).toBe('');
  });
  test('ampersand escaped first (no double-escape of entities)', async ({ page }) => {
    expect(await page.evaluate(() => esc('&lt;'))).toBe('&amp;lt;');
  });
});

test.describe('date helpers', () => {
  test('ymd zero-pads month and day', async ({ page }) => {
    // Local-time constructor; ymd reads local getMonth/getDate.
    const out = await page.evaluate(() => ymd(new Date(2026, 0, 5))); // Jan 5
    expect(out).toBe('2026-01-05');
  });
  test('ymd handles double-digit month/day', async ({ page }) => {
    const out = await page.evaluate(() => ymd(new Date(2026, 11, 25))); // Dec 25
    expect(out).toBe('2026-12-25');
  });
  test('today() matches YYYY-MM-DD and equals ymd(now)', async ({ page }) => {
    const { t, sameAsYmd } = await page.evaluate(() => ({
      t: today(), sameAsYmd: today() === ymd(new Date()),
    }));
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sameAsYmd).toBe(true);
  });
});

test.describe('arr (coercion)', () => {
  test('wraps a scalar', async ({ page }) => {
    expect(await page.evaluate(() => arr('x'))).toEqual(['x']);
  });
  test('passes an array through unchanged', async ({ page }) => {
    expect(await page.evaluate(() => arr([1, 2]))).toEqual([1, 2]);
  });
  test('null/undefined -> empty array', async ({ page }) => {
    expect(await page.evaluate(() => arr(null))).toEqual([]);
    expect(await page.evaluate(() => arr(undefined))).toEqual([]);
  });
});

test.describe('Solar theme math', () => {
  test('resolveDark honours explicit light/dark', async ({ page }) => {
    expect(await page.evaluate(() => resolveDark('dark'))).toBe(true);
    expect(await page.evaluate(() => resolveDark('light'))).toBe(false);
  });

  test('sunTimes: NYC midsummer — both events present at plausible UTC hours', async ({ page }) => {
    // NYC ~ (40.71, -74.01). 2026-06-21. Sunrise ~05:25 EDT = ~09:25 UTC,
    // sunset ~20:31 EDT = ~00:31 UTC *next* UTC day. sunTimes() deliberately
    // anchors BOTH events to the input's UTC date (see its comment), so the raw
    // sunset can read earlier-in-the-day than sunrise at western longitudes —
    // that cross-midnight skew is exactly what resolveSolar() corrects for by
    // sampling -1/0/+1 days. So here we only assert each event's time-of-day is
    // plausible, NOT their absolute ordering.
    const r = await page.evaluate(() => {
      const st = sunTimes(new Date(Date.UTC(2026, 5, 21)), 40.71, -74.01);
      return {
        haveBoth: !!(st.sunrise && st.sunset),
        riseUTCh: st.sunrise ? st.sunrise.getUTCHours() : null,
        setUTCh: st.sunset ? st.sunset.getUTCHours() : null,
      };
    });
    expect(r.haveBoth).toBe(true);
    expect(r.riseUTCh).toBeGreaterThanOrEqual(8);  // morning, EDT
    expect(r.riseUTCh).toBeLessThanOrEqual(11);
    expect(r.setUTCh).toBeGreaterThanOrEqual(0);   // just-past-midnight UTC = ~20:30 EDT
    expect(r.setUTCh).toBeLessThanOrEqual(2);
  });

  test('sunTimes: polar summer returns null sunset (sun never sets)', async ({ page }) => {
    // Far north (78°N, Svalbard) at summer solstice: midnight sun -> no sunset.
    const r = await page.evaluate(() => {
      const st = sunTimes(new Date(Date.UTC(2026, 5, 21)), 78.0, 15.0);
      return { sunset: st.sunset, sunrise: st.sunrise };
    });
    expect(r.sunset).toBeNull();
  });

  test('resolveSolar with no geo falls back to clock heuristic (never osDark)', async ({ page }) => {
    const r = await page.evaluate(() => {
      localStorage.removeItem('ink_geo');
      const s = resolveSolar();
      return { darkType: typeof s.dark, hasNext: 'next' in s };
    });
    expect(r.darkType).toBe('boolean');
    expect(r.hasNext).toBe(true);
  });

  test('resolveSolar with seeded geo returns {dark, next:number}', async ({ page }) => {
    const r = await page.evaluate(() => {
      localStorage.setItem('ink_geo', JSON.stringify({ lat: 40.71, lng: -74.01 }));
      const s = resolveSolar();
      return { darkType: typeof s.dark, nextType: typeof s.next };
    });
    expect(r.darkType).toBe('boolean');
    expect(r.nextType).toBe('number'); // ms until next transition
  });

  test('clockFallback returns a future transition (next > 0)', async ({ page }) => {
    const r = await page.evaluate(() => clockFallback());
    expect(typeof r.dark).toBe('boolean');
    expect(r.next).toBeGreaterThan(0);
  });
});
