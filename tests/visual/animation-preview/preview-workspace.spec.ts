import { expect, test, type Page } from '@playwright/test';

/**
 * Clip Preview is temporary, pose-only, and provably both.
 *
 * The claim being tested is not "the preview looks right" — it is that
 * previewing leaves the canonical bytes alone, that it says what it does and
 * does not do, and that it is visible in Isolate rather than sending the user
 * to World view to see the thing they just pressed Play on.
 *
 * The target model changed with it: Follow Selection is the default, and the
 * "explicit target" guarantee the old panel had is now Pin — which is what it
 * always meant. The test for it moved rather than disappeared.
 */

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__ATC_TEST__));
  await page.evaluate(() => window.__ATC_TEST__!.enableWorld());
  if (!(await page.getByTestId('workspace-dock').isVisible())) {
    await page.getByTestId('workspace-asset-library').click();
  }
  await page.getByTestId('workspace-animation').click();
  await expect(page.getByTestId('animation-workspace')).toBeVisible();
}

/**
 * Selects an instance and gets the hierarchy back out of the way.
 *
 * Below 900px the hierarchy is a fixed overlay rather than a reserved column
 * (styles.css), so leaving it open covers the bottom dock and every click into
 * the workspace lands on the tree instead. Closing it is what a human does
 * too; the narrow layout gives the screen to one overlay at a time.
 */
async function selectInstance(page: Page, instanceId: string): Promise<void> {
  const opened = !(await page.getByTestId('hierarchy').isVisible());
  if (opened) await page.getByTestId('toggle-hierarchy').click();
  await page.getByTestId(`scene-node-instance-${instanceId}`).click();
  const narrow = await page.evaluate(() => !window.matchMedia('(min-width: 901px)').matches);
  if (narrow) await page.getByTestId('toggle-hierarchy').click();
}

async function advance(page: Page, ticks: number) {
  await page.evaluate((count) => window.__ATC_TEST__!.advanceWorldTicks(count), ticks);
  await page.evaluate(() => window.__ATC_TEST__!.flushReact());
}

async function observe(page: Page) {
  return page.evaluate(() => window.__ATC_TEST__!.observeWorld());
}

test.describe('clip preview workspace', () => {
  test('clip preview does not modify the world or its simulation', async ({ page }) => {
    await open(page);
    await selectInstance(page, 'controlled-humanoid');
    await advance(page, 60);
    const before = await observe(page);

    await page.getByTestId('clip-preview-state').selectOption('run');
    await page.getByTestId('clip-preview-play').click();
    await advance(page, 60);

    const after = await observe(page);
    // The simulation advanced by exactly the ticks asked for, and every
    // instance's *simulated* state is what an unpreviewed run would give.
    expect(after.tick).toBe(before.tick + 60);
    const previewed = after.instances.find((e) => e.instanceId === 'controlled-humanoid')!;
    // The observation reads the runtime, not the preview: the override lives
    // downstream of it, in the pose the renderer asks for.
    expect(previewed.layers.locomotion?.stateId).toBe('idle');
  });

  test('the preview announces that it is pose-only and clears completely', async ({ page }) => {
    await open(page);
    await selectInstance(page, 'controlled-humanoid');
    await page.getByTestId('clip-preview-state').selectOption('run');

    // Always visible, never only in a tooltip.
    await expect(page.getByTestId('clip-preview-pose-only')).toBeVisible();
    await expect(page.getByTestId('clip-preview-semantics')).toContainText('POSE ONLY');
    await expect(page.getByTestId('clip-preview-semantics')).toContainText('not executed');
    await expect(page.getByTestId('preview-active-banner')).toBeVisible();

    await page.getByTestId('clip-preview-clear').click();
    await expect(page.getByTestId('preview-active-banner')).toHaveCount(0);
    // Cleared means cleared: no parked source left behind to quietly resume.
    await expect(page.getByTestId('clip-preview-state')).toHaveValue('');
  });

  test('the target follows the hierarchy selection by default', async ({ page }) => {
    await open(page);
    await selectInstance(page, 'controlled-humanoid');
    await expect(page.getByTestId('animation-target-instance')).toHaveText('controlled-humanoid');

    await selectInstance(page, 'scripted-humanoid');
    await expect(page.getByTestId('animation-target-instance')).toHaveText('scripted-humanoid');
  });

  test('a pinned target stays put while the selection moves', async ({ page }) => {
    await open(page);
    await selectInstance(page, 'controlled-humanoid');
    await page.getByTestId('animation-target-pin').click();
    await expect(page.getByTestId('animation-target-pinned')).toBeVisible();

    await selectInstance(page, 'scripted-humanoid');
    // The scene inspector followed the click; the animation target did not.
    await expect(page.getByTestId('animation-target-instance')).toHaveText('controlled-humanoid');

    await page.getByTestId('animation-target-follow').click();
    await expect(page.getByTestId('animation-target-instance')).toHaveText('scripted-humanoid');
  });

  test('the transport reports real clip seconds rather than a fixed loop', async ({ page }) => {
    await open(page);
    await selectInstance(page, 'controlled-humanoid');
    await page.getByTestId('clip-preview-state').selectOption('run');

    const readout = await page.getByTestId('clip-preview-time').textContent();
    // `0.00 s / <duration> s`, and the duration is the clip's own.
    expect(readout).toMatch(/^0\.00 s \/ \d+\.\d\d s$/);
    const duration = Number(readout!.split('/')[1]!.trim().replace(' s', ''));
    expect(duration).toBeGreaterThan(0);

    await page.getByTestId('clip-preview-play').click();
    await page.evaluate((seconds) => window.__ATC_TEST__!.animation.stepClipPreview(seconds), 0.05);
    const state = await page.evaluate(() => window.__ATC_TEST__!.animation.readClipPreview());
    expect(state!.durationSec).toBeCloseTo(duration, 2);
    expect(state!.timeSec).toBeCloseTo(0.05, 3);
  });

  test('clip preview is visible in Isolate, with no switch-to-World workaround', async ({
    page,
  }) => {
    await open(page);
    await selectInstance(page, 'controlled-humanoid');
    await page.getByTestId('clip-preview-state').selectOption('run');
    await page.getByTestId('clip-preview-play').click();

    // Isolate is a visibility filter over the same renderer, so the override
    // is on screen in both presentations.
    while ((await page.getByTestId('toggle-world-mode').textContent()) !== 'View: Isolate') {
      await page.getByTestId('toggle-world-mode').click();
    }
    await expect(page.getByTestId('world-viewport-canvas')).toBeVisible();
    await expect(page.getByTestId('preview-needs-world-view')).toHaveCount(0);
  });

  test('switching to State Sandbox runs the real runtime and leaves the world alone', async ({
    page,
  }) => {
    await open(page);
    await selectInstance(page, 'controlled-humanoid');
    await advance(page, 30);
    const before = await observe(page);

    await page.getByTestId('animation-mode-state-sandbox').click();
    await expect(page.getByTestId('sandbox-runtime-badge')).toBeVisible();
    await expect(page.getByTestId('sandbox-semantics')).toContainText('RUNTIME SIMULATION');

    await page.evaluate(() => window.__ATC_TEST__!.animation.stepSandbox(120));
    await page.evaluate(() => window.__ATC_TEST__!.flushReact());

    const observation = await page.evaluate(() =>
      window.__ATC_TEST__!.animation.readSandboxObservation(),
    );
    expect(observation!.tick).toBe(120);

    // 120 sandbox ticks; zero world ticks.
    const after = await observe(page);
    expect(after.tick).toBe(before.tick);
    expect(after.instances).toEqual(before.instances);
  });
});
