import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Some environments ship a pre-installed Chromium whose build number does not
 * match the one this Playwright version would download. When that binary is
 * present, point at it directly rather than fetching another copy; otherwise
 * fall back to Playwright's own managed browser.
 */
const PREINSTALLED_CHROMIUM = '/opt/pw-browsers/chromium';
const executablePath = existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined;

/**
 * Visual and interaction coverage (PLAN 17.2). The dev server and the API are
 * both started here so a fresh clone can run `npx playwright test` with no
 * manual setup — and so the tests exercise the same wiring a human would use.
 */
export default defineConfig({
  testDir: './tests/visual',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : [['line']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // WebGL in headless Chromium needs software rendering in a container.
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-landscape',
      use: { ...devices['Pixel 5 landscape'] },
    },
    {
      name: 'narrow',
      // The plan requires the UI to survive down to 320 CSS px.
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 640 }, isMobile: false },
    },
  ],
  webServer: [
    {
      command: 'npx tsx apps/api/src/server.ts',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: 'ignore',
    },
    {
      command: 'npx pnpm --filter @atc/web dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: true,
      timeout: 90_000,
      stdout: 'ignore',
    },
  ],
});
