# Ink — QA Testing Plan

Ink is a single-file vanilla-JS PWA (`index.html`, no build step). Almost all
logic lives as **top-level functions in the page `<script>`, so they are global
on `window`** — Playwright can call the *real* functions via `page.evaluate`,
with **zero copy/drift**. That is the core of this harness: we test the shipped
code, not a re-implementation.

## Framework

[Playwright](https://playwright.dev) (already installed, v1.60, Chromium cached).
A throwaway `python3 -m http.server` serves the app on `:8181` so `fetch`,
origin, and same-origin localStorage behave like production. The `tests/` dir is
**additive** — it does not touch `index.html` and adds no build step to the app.

Run: `cd tests && npm test`   (or `npx playwright test`)

## Risk ranking (what we actually test, highest value first)

| # | Area | Why it's risky | Coverage |
|---|------|----------------|----------|
| 1 | **Offline outbox** (`queueWrite`, `flushOutbox`, `sbFetch`) | Newest architecture (patch #0d3d0bb2). FIFO + parent→child UUID links + drop-vs-stop semantics are subtle and silent when wrong. | `outbox.spec.js` |
| 2 | **Solar theme** (`sunTimes`, `resolveSolar`, `clockFallback`, `resolveDark`) | Two recent UTC date-anchor bugfixes (f01c4b5, 4e409a8). Pure math, easy to regress silently. | `logic.spec.js` |
| 3 | **Date helpers** (`today`, `ymd`) | Feed record keys + journal grouping. Zero-pad / local-TZ off-by-one. | `logic.spec.js` |
| 4 | **`esc`** | XSS surface — all user prose is escaped through it. | `logic.spec.js` |
| 5 | **`toRoman`, `arr`** | Display + coercion glue; cheap to pin. | `logic.spec.js` |
| 6 | **Boot / auth gate** | No-session → OTP gate; session → home. Regression guard that boot doesn't throw. | `smoke.spec.js` |

## What these tests deliberately do NOT cover

- **Real Supabase / Anthropic network calls.** All network is stubbed or
  offline-forced. We test *our* queueing/replay logic, not the backends.
- **Real OTP auth round-trip** (needs a live inbox).
- **Service worker caching** (`sw.js`) — disabled under test origin.
- **Visual/layout, swipe gesture physics, iOS safe-area.** Out of scope for
  logic QA; would need device/visual-regression tooling.
- **`callClaude` parsing** — only the no-key throw path is reachable offline.

This catches *logic* regressions (the silent, dangerous kind). It is not a
substitute for a human running the real flows after a change.

## Outbox invariants pinned (the crown jewel)

1. POST with `Prefer: return=representation` **mints a client UUID** and echoes
   it back optimistically — so a child write can reference the parent id before
   the server ever sees it (preserves `source_entry_id` link on replay).
2. A provided `id` is **kept**, not overwritten.
3. Consecutive PATCHes to the same path **collapse** (debounced autosave doesn't
   bloat the queue); the *last* body wins.
4. `flushOutbox` replays **FIFO** and **stops on the first network failure**
   (order + parent→child deps intact for next time).
5. A server-rejected op (non-2xx, non-404/409) is **dropped** so one bad op
   can't wedge the queue; 404/409 are treated as already-applied.
6. `sbFetch` queues writes when `navigator.onLine === false` (skips a doomed
   fetch) and on mid-flight network error.
