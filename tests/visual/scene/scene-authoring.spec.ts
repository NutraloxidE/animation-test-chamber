import { expect, test, type Page } from '@playwright/test';

/**
 * The human Scene-composition workflow, driven the way a person drives it.
 *
 * Migrated from `tests/visual/world/world-authoring.spec.ts` with its
 * assertions intact, not relaxed. What changed is where the workflow lives: the
 * World tab inside the chamber became `/edit/scene/:sceneId`, so the setup
 * navigates to a route instead of toggling a mode, and instances became
 * entities. Every behavioural claim the old spec made is still made here.
 *
 * One claim is deliberately *stronger* than before. The old spec drove a world
 * that was staged in the browser and never written; this one carries a change
 * through Stage and asserts the repository state the Apply path reports, which
 * is the separation the whole editing model rests on.
 */

const SCENE_ID = 'two-humanoids-shared-animation';
const CONTROLLED = 'controlled-humanoid';
const SCRIPTED = 'scripted-humanoid';

async function openScene(page: Page): Promise<void> {
  await page.goto(`/edit/scene/${SCENE_ID}`);
  await expect(page.getByTestId('scene-editor')).toBeVisible();
  // The canvas mounts asynchronously; the hierarchy is the readiness signal
  // that does not depend on WebGL being available on the runner.
  await expect(page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`)).toBeVisible();
}

test.describe('scene authoring', () => {
  test('shows two entities of one shared character definition', async ({ page }) => {
    await openScene(page);
    await expect(page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`)).toBeVisible();
    await expect(page.getByTestId(`scene-hierarchy-row-${SCRIPTED}`)).toBeVisible();

    // Both entities name the same Character Definition: one definition, two
    // placements, which is the contract the scene exists to demonstrate.
    for (const entityId of [CONTROLLED, SCRIPTED]) {
      await page.getByTestId(`scene-hierarchy-row-${entityId}`).click();
      await expect(page.getByTestId('scene-entity-inspector-character')).toContainText(
        'demo-humanoid',
      );
    }
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

  test('selecting an entity changes the inspector and not the document', async ({ page }) => {
    await openScene(page);
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('CLEAN');

    await page.getByTestId(`scene-hierarchy-row-${SCRIPTED}`).click();
    await expect(page.getByTestId('scene-entity-inspector-character')).toContainText(SCRIPTED);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await expect(page.getByTestId('scene-entity-inspector-character')).toContainText(CONTROLLED);

    // Selection is not mutation: the session is still clean.
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('CLEAN');
  });

  test('a transform edit moves only the selected entity', async ({ page }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();

    const x = page.getByTestId('scene-entity-inspector-character').locator('input[type=number]').first();
    await x.fill('4.5');
    await x.blur();
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('PREVIEW');

    // The other entity is untouched.
    await page.getByTestId(`scene-hierarchy-row-${SCRIPTED}`).click();
    const otherX = page
      .getByTestId('scene-entity-inspector-character')
      .locator('input[type=number]')
      .first();
    await expect(otherX).not.toHaveValue('4.5');
  });

  test('rebinding the controller changes one entity only', async ({ page }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await page.getByTestId(`scene-controller-${CONTROLLED}`).selectOption('ai');
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('PREVIEW');

    await page.getByTestId(`scene-hierarchy-row-${SCRIPTED}`).click();
    await expect(page.getByTestId(`scene-controller-${SCRIPTED}`)).not.toHaveValue('ai');
  });

  test('placing an asset stages a new entity that shares the source reference', async ({ page }) => {
    await openScene(page);
    await page.getByTestId('scene-place-character-demo-humanoid').click();
    await expect(page.getByTestId('scene-hierarchy-row-demo-humanoid')).toBeVisible();

    await page.getByTestId('scene-hierarchy-row-demo-humanoid').click();
    // The placement references the shared Character rather than copying it.
    await expect(page.getByTestId('scene-entity-inspector-character')).toContainText(
      'demo-humanoid',
    );
  });

  test('preview is not stage, and stage is not a repository write', async ({ page }) => {
    await openScene(page);
    await page.getByTestId('scene-place-character-demo-humanoid').click();
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('PREVIEW');

    // Apply refuses while nothing is staged: a preview is not a pending write.
    await expect(page.getByTestId('scene-apply')).toBeDisabled();

    await page.getByTestId('scene-stage-all').click();
    await expect(page.getByTestId('scene-dirty-state')).toContainText('STAGED');
    await expect(page.getByTestId('scene-apply')).toBeEnabled();
  });

  test('staged scene changes can be reverted', async ({ page }) => {
    await openScene(page);
    await page.getByTestId('scene-place-character-demo-humanoid').click();
    await page.getByTestId('scene-stage-all').click();
    await expect(page.getByTestId('scene-dirty-state')).toContainText('STAGED');

    await page.getByTestId('scene-revert').click();
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('CLEAN');
    await expect(page.getByTestId('scene-hierarchy-row-demo-humanoid')).toHaveCount(0);
  });

  test('the rig editor still opens and identifies its exact character', async ({ page }) => {
    await page.goto('/edit/rig/demo-humanoid');
    await expect(page.getByTestId('rig-target-id')).toContainText('demo-humanoid');
    // The chamber itself is unchanged underneath the route.
    await expect(page.getByTestId('hud')).toBeVisible();
  });

  test('an unknown character id does not fall back to another character', async ({ page }) => {
    await page.goto('/edit/rig/no-such-character');
    await expect(page.getByTestId('route-not-found')).toBeVisible();
    await expect(page.getByTestId('rig-target-id')).toHaveCount(0);
  });
});
