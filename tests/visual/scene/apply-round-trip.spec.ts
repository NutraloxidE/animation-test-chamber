import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { REPOSITORY_IS_DISPOSABLE, REPOSITORY_ROOT } from '../repository.ts';

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

const SOURCE_REPO = fileURLToPath(new URL('../../..', import.meta.url));

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
  cpSync(join(SOURCE_REPO, PROJECT_PATH), join(REPOSITORY_ROOT, PROJECT_PATH));
  for (const path of ['reports/apply', '.chamber-transactions']) {
    rmSync(join(REPOSITORY_ROOT, path), { recursive: true, force: true });
  }
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

/** Places a camera, stages it, and applies. */
async function placeAndApply(page: Page): Promise<void> {
  await page.getByTestId('scene-place-camera').click();
  await page.getByTestId('scene-stage-all').click();
  await expect(page.getByTestId('scene-apply')).toBeEnabled();
  await page.getByTestId('scene-apply').click();
}

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
     * for. Out through the entity inspector's Rig Editor link, back through
     * browser history.
     */
    await page.getByTestId(`scene-hierarchy-row-${CONTROLLED}`).click();
    await page.getByRole('link', { name: /Open .* in the Rig Editor/ }).click();
    await expect(page).toHaveURL(/\/edit\/rig\//);
    await expect(page.getByTestId('rig-target-id')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/edit/scene/${SCENE_ID}$`));
    await expect(page.getByTestId('scene-editor')).toBeVisible();

    // Rebuilt from the store. A stale project here recreates the pre-Apply
    // scene, silently, and looks exactly like a scene that was never edited.
    await expect(page.getByTestId('scene-hierarchy-row-camera')).toBeVisible();
    await expect(revisions(page).repository).toHaveText(applied);
  });

  test('a second Apply succeeds without reloading the page', async ({ page }) => {
    await openScene(page);
    await placeAndApply(page);
    await expect(page.getByTestId('scene-dirty-state')).toHaveText('APPLIED');

    // A stale baseline here is refused as a conflict with this page's own
    // previous write — the first thing a user hits when they apply twice.
    await page.getByTestId('scene-hierarchy-row-camera').click();
    await page.getByTestId('scene-place-camera').click();
    await page.getByTestId('scene-stage-all').click();
    await page.getByTestId('scene-apply').click();

    await expect(page.getByTestId('scene-dirty-state')).toHaveText('APPLIED');
    // Both changes are in the repository, not just the second.
    await expect(page.getByTestId('scene-hierarchy-row-camera')).toBeVisible();
    await expect(page.getByTestId('scene-hierarchy-row-camera-2')).toBeVisible();
  });

  test('an Apply that changes nothing reports NO CHANGE, not APPLIED', async ({ page }) => {
    await openScene(page);
    const before = (await revisions(page).repository.textContent())!;

    /*
     * Renaming the scene to the name it already has. The operation is real, the
     * server replays it, and it produces the document already on disk — so
     * nothing is written and no revision is minted.
     */
    // The root inspector's display-name field. No `type` attribute on it, so a
    // `input[type=text]` selector matches nothing.
    const name = page.getByTestId('scene-root-inspector').locator('input').first();
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
    await page.getByTestId('scene-place-camera').click();
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
        operations: [{ type: 'scene.rename', displayName: 'Renamed by someone else' }],
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
    await expect(page.getByTestId('scene-target-name')).not.toHaveText('Renamed by someone else');
    // ...and the staged work is still here to inspect and resubmit.
    await expect(page.getByTestId('scene-hierarchy-row-camera')).toBeVisible();
  });
});
