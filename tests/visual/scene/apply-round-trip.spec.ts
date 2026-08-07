import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { REPOSITORY_IS_DISPOSABLE, REPOSITORY_ROOT, resetRepositoryProject } from '../repository.ts';

/**
 * The Apply round-trip, in a real browser, against a real repository.
 *
 * These are here rather than in a unit test because the thing that broke could
 * not be seen from inside the session. `useSceneSession` moved the session's
 * own revision after an Apply and left the store's `canonicalProject` holding
 * pre-Apply data. Every direct `DocumentEditSession` test still passed — the
 * session was correct — while the *application* held a document that was no
 * longer on disk. It only became visible when something re-read the store: a
 * route change, another panel, or a session rebuilt from it.
 *
 * So each test below asserts against what the page shows after crossing a
 * boundary the session does not own.
 *
 * This suite writes to the repository through the real endpoint, so it runs
 * only under `pnpm harness:visual`, which points the API at a disposable
 * checkout. Run outside that wrapper it would write to the developer's own
 * project, so it skips instead — a test that quietly corrupts your working tree
 * is worse than a test that did not run.
 */

const SCENE_ID = 'two-humanoids-shared-animation';
const CONTROLLED = 'controlled-humanoid';
const PROJECT_PATH = 'projects/demo-character/project.json';

test.skip(
  !REPOSITORY_IS_DISPOSABLE,
  'writes to the repository; run `pnpm harness:visual` so it targets a disposable checkout',
);

/*
 * Each test starts from the seeded project, restored on disk.
 *
 * Not politeness — a correctness requirement. The browser seeds its
 * `canonicalProject` from a compile-time import of `project.json`, so once one
 * test has applied, the repository has moved and the next page load opens
 * against a baseline that no longer exists. Every following Apply would then be
 * refused as a conflict, and each of the three Playwright projects replays the
 * same file against the same checkout.
 *
 * Restoring makes each test independent of the ones before it, which is the
 * only way these assertions mean what they say.
 */
test.beforeEach(() => {
  resetRepositoryProject();
  expect(existsSync(join(REPOSITORY_ROOT, PROJECT_PATH))).toBe(true);
});

async function openScene(page: Page): Promise<void> {
  await page.goto(`/edit/scene/${SCENE_ID}`);
  await expect(page.getByTestId('scene-editor')).toBeVisible();
  await expect(page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`)).toBeVisible();
}

function revisions(page: Page) {
  return {
    base: page.getByTestId('scene-base-revision'),
    repository: page.getByTestId('scene-repository-revision'),
  };
}

/** Places a camera Prefab, stages it, and applies. */
async function placeAndApply(page: Page): Promise<void> {
  await page.getByTestId('scene-place-prefab-default-scene-camera').click();
  await page.getByTestId('scene-stage-all').click();
  await expect(page.getByTestId('scene-apply')).toBeEnabled();
  await page.getByTestId('scene-apply').click();
}

const PLACED = 'scene-hierarchy-row-default-scene-camera';

test.describe('apply round trip', () => {
  test('the repository revision and the session baseline agree after Apply', async ({ page }) => {
    await openScene(page);
    const before = await revisions(page).repository.textContent();

    await placeAndApply(page);

    await expect(page.getByTestId('scene-dirty-state')).toHaveText('APPLIED');

    // The store adopted the returned project: its revision moved...
    await expect(revisions(page).repository).not.toHaveText(before!);
    // ...and it is the same revision the session will declare on its next Apply.
    const repository = (await revisions(page).repository.textContent())!.replace(
      'Repository revision: ',
      '',
    );
    await expect(revisions(page).base).toHaveText(`Base revision: ${repository}`);
  });

  test('the applied scene survives navigating away and back', async ({ page }) => {
    await openScene(page);
    await placeAndApply(page);
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('APPLIED');
    const applied = (await revisions(page).repository.textContent())!;

    /*
     * Client-side navigation, both ways, and deliberately not `page.goto`: a
     * full document load re-seeds the store from scratch, so it cannot fail the
     * way a stale in-memory project does — which is the only thing this test is
     * for. Out through the inspector's editor link — which now redirects to the
     * Prefab the Character became — and back through browser history. The
     * redirect `replace`s, so one Back returns to the Scene.
     */
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await page.getByTestId('scene-open-prefab').click();
    await expect(page).toHaveURL(/\/edit\/prefab\//);
    await expect(page.getByTestId('prefab-target-id')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/edit/scene/${SCENE_ID}$`));
    await expect(page.getByTestId('scene-editor')).toBeVisible();

    // Rebuilt from the store. A stale project here recreates the pre-Apply
    // scene, silently, and looks exactly like a scene that was never edited.
    await expect(page.getByTestId(PLACED)).toBeVisible();
    await expect(revisions(page).repository).toHaveText(applied);
  });

  test('a second Apply succeeds without reloading the page', async ({ page }) => {
    await openScene(page);
    await placeAndApply(page);
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('APPLIED');

    // A stale baseline here is refused as a conflict with this page's own
    // previous write — the first thing a user hits when they apply twice.
    await page.getByTestId(PLACED).click();
    await page.getByTestId('scene-place-prefab-default-scene-camera').click();
    await page.getByTestId('scene-stage-all').click();
    await page.getByTestId('scene-apply').click();

    await expect(page.getByTestId('scene-dirty-state')).toHaveText('APPLIED');
    // Both changes are in the repository, not just the second.
    await expect(page.getByTestId(PLACED)).toBeVisible();
    await expect(page.getByTestId('scene-hierarchy-row-default-scene-camera-2')).toBeVisible();
  });

  test('an Apply that changes nothing reports NO CHANGE, not APPLIED', async ({ page }) => {
    await openScene(page);
    const before = (await revisions(page).repository.textContent())!;

    /*
     * Renaming a GameObject to the name it already has. The operation is real,
     * the server replays it, and it produces the document already on disk — so
     * nothing is written and no revision is minted.
     */
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    const name = page.getByTestId('scene-inspector-rename');
    const current = await name.inputValue();
    await name.fill(`${current} temporarily`);
    await name.fill(current);
    await name.blur();

    await page.getByTestId('scene-stage-all').click();

    if (await page.getByTestId('scene-apply').isEnabled()) {
      await page.getByTestId('scene-apply').click();
      await expect(page.getByTestId('scene-dirty-state')).toHaveText('NO CHANGE');
      await expect(page.getByTestId('scene-apply-result')).toContainText('No change');
    } else {
      // Nothing staged at all: the session refused to record the no-op, which
      // is the same invariant enforced one layer earlier. Either is correct;
      // what must never happen is APPLIED.
      await expect(page.getByTestId('scene-dirty-state')).toHaveText('CLEAN');
    }

    // Either way the repository did not move.
    await expect(revisions(page).repository).toHaveText(before);
  });

  test('external repository movement produces a real conflict, silently adopting nothing', async ({
    page,
  }) => {
    await openScene(page);
    const scene = await page.getByTestId('scene-target-id').textContent();
    expect(scene).toContain(SCENE_ID);

    // Stage a local edit, but do not apply it yet.
    await page.getByTestId('scene-place-prefab-default-scene-camera').click();
    await page.getByTestId('scene-stage-all').click();
    await expect(page.getByTestId('scene-dirty-state')).toContainText('STAGED');

    /*
     * Something else moves the repository forward underneath this page — a
     * second editor, an agent, a script. Sent through the same endpoint the
     * browser uses, so the repository moves exactly as it would in life.
     */
    const response = await page.request.get('/api/project');
    expect(response.ok()).toBe(true);
    const { project } = (await response.json()) as { project: { revisionId: string } };

    const external = await page.request.post('/api/repository/apply', {
      data: {
        target: { kind: 'scene', id: SCENE_ID },
        expected: { projectRevisionId: project.revisionId },
        operations: [
          {
            type: 'scene.rename_game_object',
            gameObjectId: CONTROLLED,
            displayName: 'Renamed by someone else',
          },
        ],
        actor: 'human',
        intent: 'an external writer moves the repository',
      },
    });
    expect(external.status()).toBe(200);

    await page.getByTestId('scene-apply').click();

    // A conflict, named as one: the next move is reload-and-reapply, which is
    // different from the edit-and-retry an "invalid" would imply.
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('CONFLICT');

    // The external content was not silently adopted into this page...
    await expect(page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`)).not.toContainText(
      'Renamed by someone else',
    );
    // ...and the staged work is still here to inspect and resubmit.
    await expect(page.getByTestId(PLACED)).toBeVisible();
  });

  /**
   * Authoring a Component override, end to end (§3.7, §19.1).
   *
   * The full loop, in a real browser against a real repository: select an
   * instance, expand it, select a node, select a Component, change one typed
   * field, stage, apply, reload the page, and find the same override still
   * there. Anything short of the reload would prove only that React held the
   * value.
   */
  test('an authored Component override survives Apply and a reload', async ({ page }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await page.getByTestId(`scene-hierarchy-expand-${CONTROLLED}`).click();
    await page.getByTestId(`scene-hierarchy-node-${CONTROLLED}-root`).click();
    await page.getByTestId('scene-inspector-node-component-model-renderer').click();

    // The editor names its exact target: instance, node, Component.
    await expect(page.getByTestId('scene-override-editor-target')).toContainText(CONTROLLED);
    await expect(page.getByTestId('scene-override-editor-target')).toContainText('root');

    // Before the edit the field is inherited from the shared Prefab.
    await expect(
      page.getByTestId('scene-override-model-renderer-castShadow-scope'),
    ).toHaveText('INHERITED');

    await page.getByTestId('scene-override-model-renderer-castShadow').uncheck();

    // After it, the same field says the instance owns this value.
    await expect(
      page.getByTestId('scene-override-model-renderer-castShadow-scope'),
    ).toHaveText('OVERRIDDEN HERE');
    await expect(page.getByTestId(`scene-hierarchy-override-${CONTROLLED}`)).toBeVisible();

    await page.getByTestId('scene-stage-all').click();
    await page.getByTestId('scene-apply').click();
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('APPLIED');

    /*
     * "Reload" means two different things here, and both are asserted.
     *
     * The *repository* is the one that matters: the override has to be in
     * `project.json` on disk, under this instance, addressing this node and
     * Component. That is read back through the API rather than through the
     * page, because the page cannot prove it — this app seeds its store from a
     * project bundled at build time and does not re-fetch on boot, so a
     * `page.goto` would show the *pre-Apply* document and prove nothing either
     * way.
     */
    const response = await page.request.get('/api/project');
    expect(response.ok()).toBe(true);
    const { project } = (await response.json()) as {
      project: {
        scenes: {
          id: string;
          gameObjects?: {
            id: string;
            componentOverrides: { nodeId: string; componentId: string; patches: unknown[] }[];
          }[];
        }[];
      };
    };
    const persisted = project.scenes
      .find((scene) => scene.id === SCENE_ID)!
      .gameObjects!.find((gameObject) => gameObject.id === CONTROLLED)!;
    expect(persisted.componentOverrides).toHaveLength(1);
    expect(persisted.componentOverrides[0]).toMatchObject({
      nodeId: 'root',
      componentId: 'model',
      patches: [{ path: '/castShadow', op: 'set', value: false }],
    });

    /*
     * And the *page* keeps it across a route change, which is the reload a user
     * actually performs. Client-side navigation, so the store is exercised
     * rather than re-seeded.
     */
    await page.getByTestId('scene-open-prefab').click();
    await expect(page).toHaveURL(/\/edit\/prefab\//);
    await page.goBack();
    await expect(page.getByTestId('scene-editor')).toBeVisible();

    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await page.getByTestId(`scene-hierarchy-expand-${CONTROLLED}`).click();
    await page.getByTestId(`scene-hierarchy-node-${CONTROLLED}-root`).click();
    await page.getByTestId('scene-inspector-node-component-model-renderer').click();

    await expect(
      page.getByTestId('scene-override-model-renderer-castShadow-scope'),
    ).toHaveText('OVERRIDDEN HERE');
    await expect(page.getByTestId('scene-override-model-renderer-castShadow')).not.toBeChecked();
  });

  test('clearing an authored override restores the inherited value', async ({ page }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await page.getByTestId(`scene-hierarchy-expand-${CONTROLLED}`).click();
    await page.getByTestId(`scene-hierarchy-node-${CONTROLLED}-root`).click();
    await page.getByTestId('scene-inspector-node-component-model-renderer').click();

    await page.getByTestId('scene-override-model-renderer-castShadow').uncheck();
    await expect(
      page.getByTestId('scene-override-model-renderer-castShadow-scope'),
    ).toHaveText('OVERRIDDEN HERE');

    await page.getByTestId('scene-override-clear').click();

    // Back to the shared Prefab's value, and the badge says so.
    await expect(
      page.getByTestId('scene-override-model-renderer-castShadow-scope'),
    ).toHaveText('INHERITED');
    await expect(page.getByTestId('scene-override-model-renderer-castShadow')).toBeChecked();
  });

  test('an out-of-range override is refused at the control, not staged', async ({ page }) => {
    await openScene(page);
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await page.getByTestId(`scene-hierarchy-expand-${CONTROLLED}`).click();
    await page.getByTestId(`scene-hierarchy-node-${CONTROLLED}-root`).click();
    await page.getByTestId('scene-inspector-node-component-capsule-collider').click();

    await page.getByTestId('scene-override-capsule-collider-radius').fill('99');

    // The reason appears next to the control, and nothing was staged.
    await expect(page.getByTestId('scene-override-refusal')).toContainText('at most');
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('CLEAN');
  });
});
