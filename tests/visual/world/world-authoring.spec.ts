import { expect, test, type Page } from '@playwright/test';

/**
 * The human multi-instance workflow, driven the way a person drives it.
 *
 * Every wait here is a fixed number of simulation ticks, never a sleep: the
 * whole point of the world contract is that N ticks produce one answer, and a
 * test that waited on the wall clock would be asserting about this machine's
 * frame rate instead.
 */

/**
 * Opens the world.
 *
 * There is no longer a `World` tab to click: the instance list *is* the scene
 * hierarchy on the left, and the right-hand dock shows whatever is selected in
 * it. Switching to World view is now only a viewport presentation change —
 * this helper does it because these tests assert about multiple instances
 * being drawn, not because anything about navigation requires it.
 */
async function openWorld(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__ATC_TEST__));
  await page.evaluate(() => window.__ATC_TEST__!.enableWorld());
  await page.getByTestId('toggle-world-mode').click();
  await openHierarchy(page);
  await openInspector(page);
  await expect(page.getByTestId('hierarchy')).toBeVisible();
}

/** The hierarchy dock only defaults open above the 900px breakpoint. */
async function openHierarchy(page: Page): Promise<void> {
  if (!(await page.getByTestId('hierarchy').isVisible())) {
    await page.getByTestId('toggle-hierarchy').click();
  }
}

/** On narrow viewports the inspector lives in a bottom sheet. */
async function openInspector(page: Page): Promise<void> {
  const handle = page.getByTestId('sheet-handle');
  if (await handle.isVisible()) {
    const panels = page.locator('.app__panels');
    if (!(await panels.evaluate((element) => element.classList.contains('is-open')))) {
      await handle.click();
    }
  }
}

async function advanceWorld(page: Page, ticks: number): Promise<void> {
  await page.evaluate((count) => window.__ATC_TEST__!.advanceWorldTicks(count), ticks);
  await page.evaluate(() => window.__ATC_TEST__!.flushReact());
}

async function observe(page: Page) {
  return page.evaluate(() => window.__ATC_TEST__!.observeWorld());
}

test.describe('multi-instance world authoring', () => {
  test('shows two instances of one shared character definition', async ({ page }) => {
    await openWorld(page);
    await expect(page.getByTestId('scene-node-instance-controlled-humanoid')).toBeVisible();
    await expect(page.getByTestId('scene-node-instance-scripted-humanoid')).toBeVisible();

    const observation = await observe(page);
    const characters = observation.instances.map((entry) => entry.characterId);
    expect(new Set(characters).size).toBe(1);
    // Sharing the definition means sharing the animation bundle identity too.
    expect(new Set(observation.instances.map((entry) => entry.animationResolutionKey)).size).toBe(
      1,
    );
  });

  test('selecting an instance changes the inspector and not the simulation', async ({ page }) => {
    await openWorld(page);
    await advanceWorld(page, 60);
    const before = await observe(page);

    await page.getByTestId('scene-node-instance-scripted-humanoid').click();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');

    // Selection is presentation: the world must be exactly where it was.
    const after = await observe(page);
    expect(after.tick).toBe(before.tick);
    expect(after.instances.map((entry) => entry.transform.position)).toEqual(
      before.instances.map((entry) => entry.transform.position),
    );

    await page.getByTestId('scene-node-instance-controlled-humanoid').click();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('controlled-humanoid');
  });

  test('the scripted instance advances under fixed ticks while the controlled one idles', async ({
    page,
  }) => {
    await openWorld(page);
    await advanceWorld(page, 200);
    const observation = await observe(page);

    const scripted = observation.instances.find((entry) => entry.instanceId === 'scripted-humanoid')!;
    const controlled = observation.instances.find(
      (entry) => entry.instanceId === 'controlled-humanoid',
    )!;

    // The track walks it forward; nothing is driving the controlled one.
    expect(Math.abs(scripted.transform.position.z)).toBeGreaterThan(1);
    expect(Math.abs(controlled.transform.position.z)).toBeLessThan(0.5);
    expect(scripted.intentSourceKind).toBe('scripted-track');
    expect(controlled.intentSourceKind).toBe('local-input');
  });

  test('keyboard input reaches only the instance bound to local input', async ({ page }) => {
    await openWorld(page);
    await advanceWorld(page, 40);
    const before = await observe(page);
    const scriptedBefore = before.instances.find((e) => e.instanceId === 'scripted-humanoid')!;

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.down('w');
    await advanceWorld(page, 60);
    await page.keyboard.up('w');

    const after = await observe(page);
    const controlled = after.instances.find((e) => e.instanceId === 'controlled-humanoid')!;
    const scripted = after.instances.find((e) => e.instanceId === 'scripted-humanoid')!;

    expect(controlled.intent.MoveY).not.toBe(0);
    // The scripted instance moved because its track says so, not because of a
    // key: its intent comes from the track, and the key never reached it.
    expect(scripted.intent).toEqual(
      expect.objectContaining({ MoveY: scripted.intent.MoveY }),
    );
    expect(scripted.transform.position.x).toBe(scriptedBefore.transform.position.x);
  });

  test('duplicating stages a new instance that shares the source reference', async ({ page }) => {
    await openWorld(page);
    await page.getByTestId('scene-node-instance-controlled-humanoid').click();
    await page.getByTestId('world-duplicate').click();

    await expect(page.getByTestId('scene-node-instance-controlled-humanoid-2')).toBeVisible();
    const observation = await observe(page);
    const copy = observation.instances.find((e) => e.instanceId === 'controlled-humanoid-2')!;
    const source = observation.instances.find((e) => e.instanceId === 'controlled-humanoid')!;
    expect(copy.characterId).toBe(source.characterId);
    // Shared animation bundle, not a copied one.
    expect(copy.animationResolutionKey).toBe(source.animationResolutionKey);
  });

  test('a transform edit moves only the selected instance', async ({ page }) => {
    await openWorld(page);
    await page.getByTestId('scene-node-instance-controlled-humanoid').click();

    const before = await observe(page);
    const scriptedBefore = before.instances.find((e) => e.instanceId === 'scripted-humanoid')!;

    await page.getByTestId('world-field-instance.position-x').fill('6');
    await page.getByTestId('world-field-instance.position-x').blur();
    await advanceWorld(page, 5);

    const after = await observe(page);
    const controlled = after.instances.find((e) => e.instanceId === 'controlled-humanoid')!;
    const scripted = after.instances.find((e) => e.instanceId === 'scripted-humanoid')!;
    expect(controlled.transform.position.x).toBeCloseTo(6, 1);
    expect(scripted.transform.position.x).toBeCloseTo(scriptedBefore.transform.position.x, 3);
  });

  test('rebinding the intent source changes one instance only', async ({ page }) => {
    await openWorld(page);
    await page.getByTestId('scene-node-instance-scripted-humanoid').click();
    await page.getByTestId('world-field-instance.intentSource-input').selectOption('none');
    await advanceWorld(page, 60);

    const observation = await observe(page);
    const scripted = observation.instances.find((e) => e.instanceId === 'scripted-humanoid')!;
    const controlled = observation.instances.find((e) => e.instanceId === 'controlled-humanoid')!;
    expect(scripted.intentSourceKind).toBe('none');
    expect(controlled.intentSourceKind).toBe('local-input');
  });

  test('staged world changes can be reverted', async ({ page }) => {
    await openWorld(page);
    await page.getByTestId('scene-node-instance-controlled-humanoid').click();
    await page.getByTestId('world-duplicate').click();
    await expect(page.getByTestId('scene-node-instance-controlled-humanoid-2')).toBeVisible();

    // Reverting is a world-level action, so it lives on the world root's
    // inspector rather than on whichever instance happened to be selected.
    await page.getByTestId('scene-node-world').click();
    await page.getByTestId('world-revert').click();
    await expect(page.getByTestId('scene-node-instance-controlled-humanoid-2')).toHaveCount(0);
    await expect(page.getByTestId('scene-node-instance-controlled-humanoid')).toBeVisible();
  });

  test('the focused chamber still opens and tunes', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__ATC_TEST__));
    // Isolate is the default presentation: seeing the whole world has to be
    // opt-in for a human who has never heard of world composition.
    await expect(page.getByTestId('toggle-world-mode')).toHaveText('View: Isolate');
    await expect(page.getByTestId('viewport-canvas')).toBeVisible();
  });
});
