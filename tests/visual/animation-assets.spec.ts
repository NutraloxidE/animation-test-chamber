import { expect, test, type Page } from '@playwright/test';

/**
 * Asset Library coverage (PLAN 41.5).
 *
 * These drive the library the way a human does — filter, search, open an asset,
 * read what it needs and who uses it, then apply it to a character — and assert
 * on behaviour rather than pixels, so they fail when the loop breaks rather
 * than when a colour changes.
 */

async function openLibrary(page: Page): Promise<void> {
  // The game owns `/`; the full repository Asset Library is an explicit editor route.
  await page.goto('/edit/assets');
  await expect(page.getByTestId('hud')).toBeVisible();
  await page.getByTestId('workspace-asset-library').click();
  await expect(page.getByTestId('asset-library')).toBeVisible();
}

/** At 320px the library is a drill-down, so the pane has to be chosen first. */
async function showPane(page: Page, pane: 'types' | 'list' | 'detail'): Promise<void> {
  const crumb = page.getByTestId(`library-pane-${pane}`);
  if (await crumb.isVisible()) await crumb.click();
}

test.beforeEach(async ({ page }) => {
  await openLibrary(page);
});

test('the workspace switch moves between the chamber and the library', async ({ page }) => {
  await expect(page.getByTestId('asset-library')).toBeVisible();
  await page.getByTestId('workspace-chamber').click();
  await expect(page.getByTestId('hud')).toBeVisible();
  await page.getByTestId('workspace-asset-library').click();
  await expect(page.getByTestId('asset-library')).toBeVisible();
});

test('lists the migrated assets and filters by type', async ({ page }) => {
  await showPane(page, 'list');
  await expect(page.getByTestId('asset-card-humanoid-third-person-base')).toBeVisible();

  await showPane(page, 'types');
  await page.getByTestId('asset-type-animation-clip').click();
  await showPane(page, 'list');
  await expect(page.getByTestId('asset-card-humanoid-third-person-base')).toHaveCount(0);
  await expect(page.getByTestId('asset-card-idle')).toBeVisible();
});

test('browses Prefabs with exact identity, usage, validation and delete policy', async ({ page }) => {
  await showPane(page, 'types');
  await page.getByTestId('asset-type-game-object-prefab').click();
  await showPane(page, 'list');
  await expect(page.getByTestId('prefab-card-navigator')).toBeVisible();
  await expect(page.getByTestId('asset-card-idle')).toHaveCount(0);

  await page.getByTestId('prefab-card-navigator').click();
  await showPane(page, 'detail');
  await expect(page.getByTestId('prefab-detail')).toContainText('navigator@1.0.0');
  await expect(page.getByTestId('prefab-components')).toContainText('animator');
  await expect(page.getByTestId('prefab-dependencies')).toContainText('animation-behavior');
  await expect(page.getByTestId('prefab-usage')).toContainText('2 Scene instance(s)');
  await expect(page.getByTestId('prefab-validation')).toContainText('valid');
  await expect(page.getByTestId('prefab-delete-policy')).toContainText('Deletion blocked');
  await expect(page.getByTestId('prefab-delete-policy')).toContainText('controlled-humanoid');
});

test('search matches a motion slot name, not just the asset id', async ({ page }) => {
  await showPane(page, 'list');
  // The slot lives inside the behaviour, so matching it proves the index carries
  // more than the card's visible text.
  await page.getByTestId('asset-search').fill('action.primary.01');
  await expect(page.getByTestId('asset-card-humanoid-third-person-base')).toBeVisible();

  await page.getByTestId('asset-search').fill('definitely-not-an-asset');
  await expect(page.getByTestId('asset-list-empty')).toBeVisible();
});

test('a behaviour detail shows its slot contract, dependants and validity', async ({ page }) => {
  await showPane(page, 'list');
  await page.getByTestId('asset-card-humanoid-third-person-base').click();
  await showPane(page, 'detail');

  await expect(page.getByTestId('asset-detail')).toBeVisible();
  await expect(page.getByTestId('behavior-motion-slots')).toContainText('locomotion.idle');
  await expect(page.getByTestId('asset-detail-version')).toHaveText('1.0.0');

  // Two characters share it, which is the reuse claim made visible.
  await expect(page.getByTestId('asset-usedby-list')).toContainText('demo-humanoid');
  await expect(page.getByTestId('asset-usedby-list')).toContainText(
    'alternate-humanoid-character',
  );
  await expect(page.getByTestId('asset-validity-humanoid-third-person-base')).toHaveText('valid');
});

test('a motion set shows every required slot bound to a clip', async ({ page }) => {
  await showPane(page, 'list');
  await page.getByTestId('asset-search').fill('demo-humanoid-motion-set');
  await page.getByTestId('asset-card-demo-humanoid-motion-set').click();
  await showPane(page, 'detail');

  const table = page.getByTestId('motion-set-table');
  await expect(table).toBeVisible();
  await expect(page.getByTestId('motion-slot-locomotion.idle')).toHaveAttribute(
    'data-status',
    'valid',
  );
  // No required slot may be missing, or the character would not start.
  await expect(page.locator('[data-status="missing"]')).toHaveCount(0);
});

test('a clip shows its authored timing and events', async ({ page }) => {
  await showPane(page, 'types');
  await page.getByTestId('asset-type-animation-clip').click();
  await showPane(page, 'list');
  await page.getByTestId('asset-search').fill('dodge');
  await page.getByTestId('asset-card-dodge').click();
  await showPane(page, 'detail');

  await expect(page.getByTestId('clip-facts')).toContainText('Duration');
  await expect(page.getByTestId('clip-preview')).toBeVisible();
  await expect(page.getByTestId('clip-events')).toContainText('Dodge');
});

test('a rig shows its bone mapping and compatibility key', async ({ page }) => {
  await showPane(page, 'types');
  await page.getByTestId('asset-type-humanoid-rig').click();
  await showPane(page, 'list');
  await page.getByTestId('asset-card-demo-humanoid-rig').click();
  await showPane(page, 'detail');

  await expect(page.getByTestId('rig-bones')).toContainText('hips');
  await expect(page.getByTestId('rig-retarget-status')).toHaveText('direct-compatible');
});

test('deleting a referenced asset is refused, and says who is holding it', async ({ page }) => {
  await showPane(page, 'list');
  await page.getByTestId('asset-card-humanoid-third-person-base').click();
  await showPane(page, 'detail');

  await expect(page.getByTestId('asset-action-delete')).toBeDisabled();
  await expect(page.getByTestId('asset-delete-blockers')).toContainText('references it at');
});

test('the apply dialog reports compatibility before anything is written', async ({ page }) => {
  await showPane(page, 'list');
  await page.getByTestId('asset-card-humanoid-third-person-base').click();
  await showPane(page, 'detail');
  await page.getByTestId('asset-action-apply').click();

  const dialog = page.getByTestId('apply-asset-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('apply-compatibility')).toContainText('direct-compatible');
  await expect(page.getByTestId('apply-submit')).toBeEnabled();
  await page.getByTestId('apply-cancel').click();
  await expect(dialog).toHaveCount(0);
});

test('the derive dialog explains what each kind of derivation means', async ({ page }) => {
  await showPane(page, 'list');
  await page.getByTestId('asset-card-humanoid-third-person-base').click();
  await showPane(page, 'detail');
  await page.getByTestId('asset-action-derive').click();

  await expect(page.getByTestId('derive-explanation')).toContainText('Stays attached');
  await page.getByTestId('derive-mode-fork').click();
  await expect(page.getByTestId('derive-explanation')).toContainText('cuts the link');
  // A fork with no stated intent is refused: "why" is the point of a fork.
  await expect(page.getByTestId('derive-submit')).toBeDisabled();
  await page.getByTestId('derive-cancel').click();
});

test('the save destination dialog shows no destinations with nothing staged, and submit stays disabled', async ({ page }) => {
  await showPane(page, 'list');
  await page.getByTestId('asset-card-humanoid-third-person-base').click();
  await showPane(page, 'detail');
  await page.getByTestId('asset-action-save-destination').click();

  const dialog = page.getByTestId('save-destination-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Where should this change live?');
  await expect(page.getByTestId('save-destination-empty')).toBeVisible();

  // Neither section has anything to choose a destination for, so neither
  // shows — a graph or clip destination picker with nothing to attach it to
  // would have no correct default (PLAN Part II §16).
  await expect(page.getByTestId('save-destination-graph-section')).toHaveCount(0);
  await expect(page.getByTestId('save-destination-clip-section')).toHaveCount(0);
  await expect(page.getByTestId('save-destination-submit')).toBeDisabled();
});

test('switching the active character changes which clips resolve', async ({ page }) => {
  await page.getByTestId('library-character-select').selectOption('alternate-humanoid-character');
  await showPane(page, 'types');
  await page.getByTestId('asset-facet-used-by-active').click();
  await showPane(page, 'list');
  await expect(page.getByTestId('asset-card-alternate-humanoid-motion-set')).toBeVisible();
  await expect(page.getByTestId('asset-card-demo-humanoid-motion-set')).toHaveCount(0);
});

test('dependencies and used-by are both reachable from a motion set', async ({ page }) => {
  await showPane(page, 'list');
  await page.getByTestId('asset-search').fill('demo-humanoid-motion-set');
  await page.getByTestId('asset-card-demo-humanoid-motion-set').click();
  await showPane(page, 'detail');

  await expect(page.getByTestId('asset-dependency-list')).toContainText('demo-humanoid-rig');
  await expect(page.getByTestId('asset-usedby-list')).toContainText('demo-humanoid');
});
