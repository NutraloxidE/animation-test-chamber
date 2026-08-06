import { expect, test, type Page } from '@playwright/test';

/**
 * The human Scene-composition workflow, driven the way a person drives it.
 *
 * Every behavioural claim the entity-era version of this spec made is still made
 * here; what changed is the vocabulary it is made in. The hierarchy rows are
 * GameObjects rather than entities, the Inspector edits a Prefab placement
 * rather than a `kind`, and the Asset Panel places an exact Prefab version
 * rather than choosing between four creation buttons.
 *
 * Several claims are deliberately *stronger* than before, because the cutover
 * made them checkable for the first time:
 *
 *   - a row names the exact `prefabId@version` it stands on, so a Scene cannot
 *     drift onto a version nobody approved without it being visible;
 *   - expanding a row shows the resolved Prefab's nodes and Components, which
 *     an entity row had nothing to show;
 *   - clicking a *child* node moves the Inspector without moving the operation
 *     target, which is the identity split §5.3 exists to protect.
 */

const SCENE_ID = 'two-humanoids-shared-animation';
const CONTROLLED = 'controlled-humanoid';
const SCRIPTED = 'scripted-humanoid';
const CAMERA = 'scene-camera';

async function openScene(page: Page): Promise<void> {
  await page.goto(`/edit/scene/${SCENE_ID}`);
  await expect(page.getByTestId('scene-editor')).toBeVisible();
  // The canvas mounts asynchronously; the hierarchy is the readiness signal
  // that does not depend on WebGL being available on the runner.
  await expect(page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`)).toBeVisible();
}

test.describe('scene authoring', () => {
  test('shows two GameObjects standing on one shared Prefab version', async ({ page }) => {
    await openScene(page);
    await expect(page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`)).toBeVisible();
    await expect(page.getByTestId(`scene-hierarchy-row-${SCRIPTED}`)).toBeVisible();

    // Both name the same exact Prefab version: one asset, two placements, which
    // is the contract the scene exists to demonstrate.
    for (const instanceId of [CONTROLLED, SCRIPTED]) {
      await expect(page.getByTestId(`scene-hierarchy-prefab-${instanceId}`)).toHaveText(
        'navigator@1.0.0',
      );
    }
  });

  test('a hierarchy row carries its Component badges', async ({ page }) => {
    await openScene(page);
    // What the object *is* comes from its Components, so those are what the row
    // shows — there is no kind icon to show instead.
    for (const componentType of ['model-renderer', 'animator', 'character-motor']) {
      await expect(
        page.getByTestId(`scene-hierarchy-component-${CONTROLLED}-${componentType}`),
      ).toBeVisible();
    }
    await expect(page.getByTestId(`scene-hierarchy-component-${CAMERA}-camera`)).toBeVisible();
  });

  test('expanding a row shows the resolved Prefab nodes and their Components', async ({ page }) => {
    await openScene(page);
    await expect(page.getByTestId(`scene-hierarchy-nodes-${CONTROLLED}`)).toHaveCount(0);

    await page.getByTestId(`scene-hierarchy-expand-${CONTROLLED}`).click();
    await expect(page.getByTestId(`scene-hierarchy-nodes-${CONTROLLED}`)).toBeVisible();
    await expect(page.getByTestId(`scene-hierarchy-node-${CONTROLLED}-root`)).toBeVisible();
    await expect(
      page.getByTestId(`scene-hierarchy-node-component-${CONTROLLED}-root-animator`),
    ).toBeVisible();
  });

  test('the route names the scene being edited', async ({ page }) => {
    await openScene(page);
    await expect(page.getByTestId('scene-target-id')).toContainText(SCENE_ID);
  });

  test('an unknown scene id does not fall back to another scene', async ({ page }) => {
    await page.goto('/edit/scene/no-such-scene');
    await expect(page.getByTestId('route-not-found')).toBeVisible();
    await expect(page.getByTestId('scene-editor')).toHaveCount(0);
  });

  test('selecting a GameObject changes the inspector and not the document', async ({ page }) => {
    await openScene(page);
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('CLEAN');

    await page.getByTestId(`scene-hierarchy-row-${SCRIPTED}`).click();
    await expect(page.getByTestId('scene-inspector-instance-id')).toHaveText(SCRIPTED);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await expect(page.getByTestId('scene-inspector-instance-id')).toHaveText(CONTROLLED);

    // Selection is not mutation: the session is still clean.
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('CLEAN');
  });

  test('selecting a child node inspects it and leaves the operation target on the root', async ({
    page,
  }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-expand-${CONTROLLED}`).click();
    await page.getByTestId(`scene-hierarchy-node-${CONTROLLED}-root`).click();

    // The node panel opens...
    await expect(page.getByTestId('scene-inspector-node')).toBeVisible();
    // ...and every persistent action still names the root instance.
    await expect(page.getByTestId('scene-inspector-instance-id')).toHaveText(CONTROLLED);
    await expect(page.getByTestId(`scene-delete-${CONTROLLED}`)).toBeVisible();
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('CLEAN');
  });

  test('the inspector labels shared Prefab data and instance-owned values', async ({ page }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();

    // A scope label on the shared side and one on the instance side. Without
    // both, "why did editing this change every other placement?" has no answer
    // on screen.
    await expect(page.getByTestId('scene-scope-shared').first()).toHaveText('SHARED PREFAB');
    await expect(page.getByTestId('scene-scope-instance').first()).toHaveText('INSTANCE ONLY');
  });

  test('Open Prefab navigates to the exact Prefab the instance stands on', async ({ page }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await page.getByTestId('scene-open-prefab').click();

    await expect(page).toHaveURL(/\/edit\/prefab\/navigator/);
    await expect(page.getByTestId('prefab-target-id')).toContainText('navigator');
  });

  test('a transform edit moves only the selected GameObject', async ({ page }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();

    const x = page.getByTestId('scene-inspector-position-x');
    await x.fill('4.5');
    await x.blur();
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('PREVIEW');

    // The other object is untouched.
    await page.getByTestId(`scene-hierarchy-row-${SCRIPTED}`).click();
    await expect(page.getByTestId('scene-inspector-position-x')).not.toHaveValue('4.5');
  });

  test('rebinding the intent changes one GameObject only', async ({ page }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await page.getByTestId('scene-inspector-binding').selectOption('ai');
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('PREVIEW');

    await page.getByTestId(`scene-hierarchy-row-${SCRIPTED}`).click();
    await expect(page.getByTestId('scene-inspector-binding')).not.toHaveValue('ai');
  });

  test('placing a Prefab stages a GameObject that names the exact version', async ({ page }) => {
    await openScene(page);
    await page.getByTestId('scene-place-prefab-navigator').click();
    await expect(page.getByTestId('scene-hierarchy-row-navigator')).toBeVisible();

    // The placement references the shared Prefab version rather than copying it.
    await expect(page.getByTestId('scene-hierarchy-prefab-navigator')).toHaveText(
      'navigator@1.0.0',
    );
  });

  test('the asset panel filters by Component, not by kind', async ({ page }) => {
    await openScene(page);
    await page.getByTestId('scene-asset-filter-cameras').click();
    await expect(page.getByTestId('scene-place-prefab-default-scene-camera')).toBeVisible();
    // A character Prefab is not a camera, and the filter is the Component
    // question rather than a tag or a name prefix.
    await expect(page.getByTestId('scene-place-prefab-navigator')).toHaveCount(0);

    await page.getByTestId('scene-asset-filter-characters').click();
    await expect(page.getByTestId('scene-place-prefab-navigator')).toBeVisible();
  });

  test('preview is not stage, and stage is not a repository write', async ({ page }) => {
    await openScene(page);
    await page.getByTestId('scene-place-prefab-navigator').click();
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('PREVIEW');

    // Apply refuses while nothing is staged: a preview is not a pending write.
    await expect(page.getByTestId('scene-apply')).toBeDisabled();

    await page.getByTestId('scene-stage-all').click();
    await expect(page.getByTestId('scene-dirty-state')).toContainText('STAGED');
    await expect(page.getByTestId('scene-apply')).toBeEnabled();
  });

  test('staged scene changes can be reverted', async ({ page }) => {
    await openScene(page);
    await page.getByTestId('scene-place-prefab-navigator').click();
    await page.getByTestId('scene-stage-all').click();
    await expect(page.getByTestId('scene-dirty-state')).toContainText('STAGED');

    await page.getByTestId('scene-revert').click();
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('CLEAN');
    await expect(page.getByTestId('scene-hierarchy-row-navigator')).toHaveCount(0);
  });

  test('duplicating a GameObject does not copy its camera relation', async ({ page }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-row-${CAMERA}`).click();
    await expect(page.getByTestId(`scene-hierarchy-relation-${CAMERA}`)).toBeVisible();

    await page.getByTestId('scene-inspector-duplicate').click();
    await expect(page.getByTestId(`scene-hierarchy-row-${CAMERA}-copy`)).toBeVisible();
    // Two cameras following one character is a thing somebody might want and
    // never a thing duplication should decide for them.
    await expect(page.getByTestId(`scene-hierarchy-relation-${CAMERA}-copy`)).toHaveCount(0);
  });

  test('the active camera must resolve to a Camera Component', async ({ page }) => {
    await openScene(page);

    // A character has no Camera Component, so it has no "Set active camera"
    // control at all — the refusal is structural rather than a dialog.
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await expect(page.getByTestId('scene-inspector-set-active-camera')).toHaveCount(0);

    await page.getByTestId(`scene-hierarchy-row-${CAMERA}`).click();
    await expect(page.getByTestId('scene-inspector-set-active-camera')).toBeVisible();
  });

  test('the scene runtime runs and can be paused and reset', async ({ page }) => {
    await openScene(page);
    // The viewport draws a running RuntimeScene, not the authored document, so
    // there is a transport for it — and "NOT RUNNING" here would mean the
    // Scene's GameObjects did not resolve.
    await expect(page.getByTestId('scene-runtime-state')).toHaveText('RUNNING');

    await page.getByTestId('scene-play-toggle').click();
    await expect(page.getByTestId('scene-runtime-state')).toHaveText('PAUSED');

    await page.getByTestId('scene-reset').click();
    await expect(page.getByTestId('scene-runtime-state')).toBeVisible();
    // Resetting the runtime is not a document edit.
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('CLEAN');
  });

  test('the prefab editor still opens and identifies its exact prefab', async ({ page }) => {
    await page.goto('/edit/prefab/navigator?component=animator');
    await expect(page.getByTestId('prefab-target-id')).toContainText('navigator');
    // The chamber itself is unchanged underneath the route.
    await expect(page.getByTestId('hud')).toBeVisible();
  });

  test('an unknown character id does not fall back to another character', async ({ page }) => {
    await page.goto('/edit/rig/no-such-character');
    await expect(page.getByTestId('route-not-found')).toBeVisible();
    await expect(page.getByTestId('prefab-target-id')).toHaveCount(0);
  });
});
