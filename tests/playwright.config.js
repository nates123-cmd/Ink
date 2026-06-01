// Playwright config for the Ink PWA. Serves the single-file app from the parent
// dir on :8181 so fetch/origin/localStorage behave like production. No app build.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:8181',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Serve the app root (parent of tests/) so index.html is at "/".
    command: 'python3 -m http.server 8181 --directory ..',
    port: 8181,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
