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
 * Ports, and why they are not constants.
 *
 * `pnpm harness:visual` runs through `harness/visual.ts`, which builds a
 * throwaway checkout, picks a free pair of ports and starts an API bound to
 * that checkout. Fixed ports plus `reuseExistingServer` would defeat the whole
 * arrangement: the isolated run would find the developer's own API already
 * listening on 8787 and happily reuse it — writing, through the real endpoint,
 * into the real repository the isolation exists to protect.
 *
 * So when the wrapper says the run is isolated, nothing is reused and the
 * servers are the ones it configured.
 */
const API_PORT = Number(process.env.API_PORT ?? 8787);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5173);
const ISOLATED = process.env.ATC_VISUAL_ISOLATED === '1';

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
    // `localhost`, not `127.0.0.1`: Vite binds the loopback *name*, which on
    // Windows resolves to ::1 first. A literal IPv4 address never reaches it,
    // and the failure looks like a dev server that never started.
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // WebGL in headless Chromium needs software rendering in a container.
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      // Host controllers make keyboard-only tests nondeterministic because the
      // production sampler correctly merges every connected input device.
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
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: !ISOLATED,
      timeout: 60_000,
      stdout: 'ignore',
      // `ATC_REPO_ROOT` reaches the server through here. Inherited env would
      // work today, but naming it makes the isolation visible at the seam that
      // depends on it.
      env: {
        API_PORT: String(API_PORT),
        ...(process.env.ATC_REPO_ROOT ? { ATC_REPO_ROOT: process.env.ATC_REPO_ROOT } : {}),
      },
    },
    {
      command: 'npx pnpm --filter @atc/web dev',
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !ISOLATED,
      timeout: 90_000,
      stdout: 'ignore',
      env: { WEB_PORT: String(WEB_PORT), API_PORT: String(API_PORT), VITE_ATC_VISUAL_TEST: '1' },
    },
  ],
});
