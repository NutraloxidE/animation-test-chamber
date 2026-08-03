import { expect, test, type Page } from '@playwright/test';

/**
 * The scene hierarchy and the contextual inspector, driven the way a person
 * drives them.
 *
 * These assert the information architecture rather than the pixels: that the
 * left panel is backed by the staged world, that it holds navigation rows and
 * no property editors, that the right panel is a function of the selection,
 * and that a display toggle cannot move the selection. Each of those was
 * true-by-convention before and is true-by-test now.
 */

/**
 * These assert information architecture — what the tree is backed by, what the
 * inspector routes to, whether a view toggle moves the selection. None of that
 * is viewport-dependent, and on narrow viewports the hierarchy and the
 * Inspector are overlays that take turns owning the screen, so a test
 * alternating between them would spend its length toggling docks and assert
 * the same facts more weakly. The narrow layout has its own test at the bottom
 * of this file, which is about the layout rather than about the architecture.
 */
// Asked inside a hook rather than through test.skip's predicate form: that
// form is handed the fixtures object first, and Playwright decides how to call
// it by inspecting the function, which a wrapper defeats.
test.beforeEach(() => {
  test.skip(
    test.info().project.name !== 'desktop',
    'information architecture is viewport-independent; narrow layout is covered separately',
  );
});

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__ATC_TEST__));
  await page.evaluate(() => window.__ATC_TEST__!.enableWorld());
  await showHierarchy(page);
}

async function showHierarchy(page: Page): Promise<void> {
  if (!(await page.getByTestId('hierarchy').isVisible())) {
    await page.getByTestId('toggle-hierarchy').click();
  }
}


async function openBottomDock(page: Page): Promise<void> {
  if (!(await page.getByTestId('workspace-dock').isVisible())) {
    await page.getByTestId('workspace-asset-library').click();
  }
}

test.describe('scene hierarchy', () => {
  test('renders the staged world as the hierarchy root', async ({ page }) => {
    await open(page);

    await expect(page.getByTestId('scene-node-world')).toBeVisible();
    await expect(page.getByTestId('scene-node-instance-controlled-humanoid')).toBeVisible();
    await expect(page.getByTestId('scene-node-instance-scripted-humanoid')).toBeVisible();
    await expect(page.getByTestId('scene-node-terrain')).toBeVisible();
    await expect(page.getByTestId('scene-node-camera')).toBeVisible();

    // Declaration order is tick order, so the tree must not reorder it.
    const ids = await page
      .locator('[data-testid^="scene-node-instance-"][role="treeitem"]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')));
    expect(ids).toEqual([
      'scene-node-instance-controlled-humanoid',
      'scene-node-instance-scripted-humanoid',
    ]);
  });

  test('derives an attachment row per equipment slot, per instance', async ({ page }) => {
    await open(page);
    // Same slot, two instances: two distinct rows, because the effective state
    // is per-instance even though the slot definition is shared.
    await expect(
      page.getByTestId('scene-node-attachment-controlled-humanoid-shield'),
    ).toBeVisible();
    await expect(page.getByTestId('scene-node-attachment-scripted-humanoid-shield')).toBeVisible();
  });

  test('the scene hierarchy contains navigation rows and no property selects', async ({ page }) => {
    await open(page);
    const tree = page.locator('.hierarchy__tree');

    // The specific controls that used to live here, by the ids they had.
    await expect(tree.getByTestId('character-select')).toHaveCount(0);
    await expect(tree.getByTestId('weapon-mode-select')).toHaveCount(0);
    // And the general claim: no form controls of any kind in the tree.
    await expect(tree.locator('select')).toHaveCount(0);
    await expect(tree.locator('input')).toHaveCount(0);
  });

  test('animator layers and states are not scene children', async ({ page }) => {
    await open(page);
    const tree = page.locator('.hierarchy__tree');
    // "run" and "idle" are graph states; they belong to the Graph workspace.
    await expect(tree.getByText('Animator', { exact: true })).toHaveCount(0);
    await expect(tree.getByText('run', { exact: true })).toHaveCount(0);

    await openBottomDock(page);
    await page.getByTestId('workspace-graph').click();
    await expect(page.getByTestId('graph-workspace')).toBeVisible();
  });

  test('collapsing a parent keeps the selection', async ({ page }) => {
    await open(page);
    await page.getByTestId('scene-node-attachment-controlled-humanoid-shield').click();
    await expect(page.getByTestId('attachment-inspector')).toBeVisible();

    await page.getByTestId('scene-node-instance-controlled-humanoid-disclosure').click();
    await expect(
      page.getByTestId('scene-node-attachment-controlled-humanoid-shield'),
    ).toHaveCount(0);
    // The row is hidden, not deselected: the inspector is still on it.
    await expect(page.getByTestId('attachment-inspector')).toBeVisible();
  });

  test('arrow keys move, expand and collapse the tree', async ({ page }) => {
    await open(page);
    const world = page.getByTestId('scene-node-world');
    await world.click();
    await expect(world).toHaveAttribute('data-selected', 'true');

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('scene-node-instance-controlled-humanoid')).toHaveAttribute(
      'data-selected',
      'true',
    );

    // Right on an expanded row steps into it; Left collapses it again.
    await page.keyboard.press('ArrowLeft');
    await expect(
      page.getByTestId('scene-node-attachment-controlled-humanoid-shield'),
    ).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(
      page.getByTestId('scene-node-attachment-controlled-humanoid-shield'),
    ).toBeVisible();

    await page.keyboard.press('ArrowUp');
    await expect(world).toHaveAttribute('data-selected', 'true');
  });
});

test.describe('contextual inspector', () => {
  test('there is no World tab', async ({ page }) => {
    await open(page);
    // The instance list is the hierarchy now; it is not reachable through, or
    // hidden behind, a tab named after a scene object.
    await expect(page.getByTestId('tab-world')).toHaveCount(0);
    await expect(page.locator('.app__panels .tabs')).toHaveCount(0);
  });

  test('selecting the world root opens world settings', async ({ page }) => {
    await open(page);
    await page.getByTestId('scene-node-world').click();

    await expect(page.getByTestId('world-inspector')).toBeVisible();
    await expect(page.getByTestId('world-inspector-focused')).toHaveText('controlled-humanoid');
    await expect(page.getByTestId('world-inspector-camera-target')).toBeVisible();
    await expect(page.getByTestId('inspector-world-tracks')).toBeVisible();
    await expect(page.getByTestId('inspector-world-actions')).toBeVisible();
  });

  test('selecting an instance opens its contextual inspector', async ({ page }) => {
    await open(page);
    await page.getByTestId('scene-node-instance-scripted-humanoid').click();

    await expect(page.getByTestId('instance-inspector')).toBeVisible();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');
    await expect(page.getByTestId('inspector-identity')).toBeVisible();
    await expect(page.getByTestId('inspector-transform')).toBeVisible();
    await expect(page.getByTestId('inspector-loadout')).toBeVisible();
    await expect(page.getByTestId('inspector-shared-definitions')).toBeVisible();
    await expect(page.getByTestId('world-runtime-state')).toBeVisible();
  });

  test('selecting terrain and camera routes to their inspectors', async ({ page }) => {
    await open(page);
    await page.getByTestId('scene-node-terrain').click();
    await expect(page.getByTestId('terrain-inspector')).toBeVisible();

    await page.getByTestId('scene-node-camera').click();
    await expect(page.getByTestId('camera-inspector')).toBeVisible();
    await expect(page.getByTestId('camera-target-instance')).toBeVisible();
  });

  test('switching between world and isolate preserves selection and inspector', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('scene-node-instance-scripted-humanoid').click();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');

    // The old button called setWorldMode *and* setPanel('world'), so this
    // click used to move the inspector off whatever was being edited.
    await page.getByTestId('toggle-world-mode').click();
    await expect(page.getByTestId('toggle-world-mode')).toHaveText('View: World');
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');
    await expect(page.getByTestId('scene-node-instance-scripted-humanoid')).toHaveAttribute(
      'data-selected',
      'true',
    );

    await page.getByTestId('toggle-world-mode').click();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');
  });

  test('changing bottom workspace does not change the selection', async ({ page }) => {
    await open(page);
    await page.getByTestId('scene-node-instance-scripted-humanoid').click();
    await openBottomDock(page);
    await page.getByTestId('workspace-graph').click();

    // The inspector stays visible and stays on the same object — the whole
    // reason editors moved out of the right-hand dock.
    await expect(page.getByTestId('graph-workspace')).toBeVisible();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');
  });

  test('opening the source character shows the definition without losing scene selection', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('scene-node-instance-scripted-humanoid').click();
    await page.getByTestId('open-source-character').click();

    await expect(page.getByTestId('project-workspace')).toBeVisible();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');
  });

  test('duplicating selects the copy; removing falls back to the world root', async ({ page }) => {
    await open(page);
    await page.getByTestId('scene-node-instance-controlled-humanoid').click();
    await page.getByTestId('world-duplicate').click();

    await expect(page.getByTestId('world-inspector-id')).toHaveText('controlled-humanoid-2');
    await expect(page.getByTestId('scene-node-instance-controlled-humanoid-2')).toHaveAttribute(
      'data-selected',
      'true',
    );

    await page.getByTestId('world-remove').click();
    // Not "the first remaining instance" — the world root, which is the one
    // selection guaranteed to survive any world edit.
    await expect(page.getByTestId('world-inspector')).toBeVisible();
    await expect(page.getByTestId('scene-node-instance-controlled-humanoid-2')).toHaveCount(0);
  });
});

/**
 * The 320px layout, asserted where it means something.
 *
 * The claim is not that everything is visible at once — it cannot be — but
 * that every dock is reachable, that the selection survives the docks opening
 * and closing, and that nothing overflows the viewport horizontally.
 */
test.describe('narrow layout', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'narrow', 'this is the 320px layout test');
  });

  test('hierarchy, inspector and workspaces are each reachable at 320px', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__ATC_TEST__));
    await page.evaluate(() => window.__ATC_TEST__!.enableWorld());

    const noOverflow = async () => {
      const [scrollWidth, clientWidth] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    };
    await noOverflow();

    // The hierarchy opens as an overlay, and a selection made in it survives
    // the overlay closing — that is the selection model doing its job.
    await page.getByTestId('toggle-hierarchy').click();
    await expect(page.getByTestId('hierarchy')).toBeVisible();
    await page.getByTestId('scene-node-instance-scripted-humanoid').click();
    await noOverflow();
    await page.getByTestId('toggle-hierarchy').click();
    await expect(page.getByTestId('hierarchy')).toBeHidden();

    // The Inspector opens over the viewport and still shows that selection.
    await page.getByTestId('sheet-handle').click();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');
    await noOverflow();

    // And closes again, releasing the viewport controls underneath it.
    await page.getByTestId('sheet-handle').click();
    await page.getByTestId('toggle-pause').click();
    await expect(page.getByTestId('toggle-pause')).toHaveText('Resume motion');

    // The bottom workspaces are reachable, and take the screen from the sheet.
    await page.getByTestId('workspace-asset-library').click();
    await expect(page.getByTestId('workspace-dock')).toBeVisible();
    await page.getByTestId('workspace-animation-preview').click();
    await expect(page.getByTestId('animation-preview')).toBeVisible();
    await noOverflow();

    // Closing the dock brings the sheet handle back, and the selection is
    // still the one made before any of this.
    await page.getByTestId('workspace-chamber').click();
    await page.getByTestId('sheet-handle').click();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');
    await noOverflow();
  });
});
