// Shared helpers for the Ink PWA test suite.
import { SB_AUTH_KEY } from './constants.js';

// Load the app and wait until the page <script> has defined its globals.
// `toRoman` is the canary — once it exists, the whole script body has run.
export async function boot(page) {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.toRoman === 'function');
}

// Seed a non-expired fake auth session BEFORE the page script runs, so boot
// takes the `hasSession() -> enterApp()` branch instead of showing the OTP gate.
// Pairs with a stubbed fetch so the (fake) token is never actually used on the wire.
export async function seedSession(page) {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({
      access_token: 'test-fake-token',
      refresh_token: 'test-fake-refresh',
      // far-future expiry (seconds) so _sessionExpired() is false
      expires_at: 4102444800,
      user: { email: 'qa@test.local' },
    }));
  }, SB_AUTH_KEY);
}

// Replace window.fetch with a no-op that returns empty JSON, before app script
// runs — neutralises all network so boot/render is deterministic and quiet.
export async function stubFetchEmpty(page) {
  await page.addInitScript(() => {
    window.fetch = async () =>
      new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}
