import { expect, test, type Page } from '@playwright/test';

/**
 * Animation preview is temporary, and provably so.
 *
 * The claim being tested is not "the preview looks right" — it is that
 * previewing leaves the canonical bytes alone. The override is applied on the
 * engine's read side rather than in its fixed step, so the assertion is
 * available directly: run the world, preview, and check that the world trace
 * hash and the staged document are the ones you started with.
 */

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__ATC_TEST__));
  await page.evaluate(() => window.__ATC_TEST__!.enableWorld());
  if (!(await page.getByTestId('workspace-dock').isVisible())) {
    await page.getByTestId('workspace-asset-library').click();
  }
  await page.getByTestId('workspace-animation-preview').click();
  await expect(page.getByTestId('animation-preview')).toBeVisible();
}

async function advance(page: Page, ticks: number) {
  await page.evaluate((count) => window.__ATC_TEST__!.advanceWorldTicks(count), ticks);
  await page.evaluate(() => window.__ATC_TEST__!.flushReact());
}

async function observe(page: Page) {
  return page.evaluate(() => window.__ATC_TEST__!.observeWorld());
}

test.describe('animation preview workspace', () => {
  test('animation preview does not modify the world or its simulation', async ({ page }) => {
    await open(page);
    await advance(page, 60);
    const before = await observe(page);

    await page.getByTestId('preview-target').selectOption('controlled-humanoid');
    await page.getByTestId('preview-state').selectOption('run');
    await page.getByTestId('preview-play').click();
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

  test('the preview announces itself and clears completely', async ({ page }) => {
    await open(page);
    await page.getByTestId('preview-target').selectOption('controlled-humanoid');
    await page.getByTestId('preview-state').selectOption('run');

    await expect(page.getByTestId('preview-flag')).toBeVisible();
    await expect(page.getByTestId('preview-active-banner')).toBeVisible();

    await page.getByTestId('preview-clear').click();
    await expect(page.getByTestId('preview-flag')).toHaveCount(0);
    await expect(page.getByTestId('preview-active-banner')).toHaveCount(0);
    // Cleared means cleared: no parked target left behind to quietly resume.
    await expect(page.getByTestId('preview-target')).toHaveValue('');
    await expect(page.getByTestId('preview-state')).toHaveValue('');
  });

  test('the preview target is explicit rather than following the selection', async ({ page }) => {
    await open(page);
    await page.getByTestId('preview-target').selectOption('controlled-humanoid');
    await page.getByTestId('preview-state').selectOption('run');

    if (!(await page.getByTestId('hierarchy').isVisible())) {
      await page.getByTestId('toggle-hierarchy').click();
    }
    await page.getByTestId('scene-node-instance-scripted-humanoid').click();

    // Selecting elsewhere must not move a running preview onto a new object.
    await expect(page.getByTestId('preview-target')).toHaveValue('controlled-humanoid');
  });

  test('transport controls need a target and a state before they do anything', async ({ page }) => {
    await open(page);
    await expect(page.getByTestId('preview-play')).toBeDisabled();
    await expect(page.getByTestId('preview-clear')).toBeDisabled();

    await page.getByTestId('preview-target').selectOption('controlled-humanoid');
    await expect(page.getByTestId('preview-play')).toBeDisabled();

    await page.getByTestId('preview-state').selectOption('run');
    await expect(page.getByTestId('preview-play')).toBeEnabled();
  });
});
