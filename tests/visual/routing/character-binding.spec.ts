import { expect, test, type Page } from '@playwright/test';

/**
 * The five canonical Characters, under the real runner (§11.3, §11.4, §11.9).
 *
 * These are the tests that would have caught the reported symptom — "selecting
 * different entries appears to open the same rig". Every other gate passed while
 * it was true: the route resolved, the header updated, the canonical document
 * changed, and the model on screen did not, because the model came from a store
 * field the route never touched.
 *
 * So the assertions are about *agreement*: for each of the five routes, the
 * header, the Character Overview and the Hierarchy's model row must all name the
 * same Character and the same model binding. Any one of them alone would have
 * passed against the bug.
 */

const CHARACTERS = [
  { id: 'demo-humanoid', name: 'Navigator', model: 'procedural-humanoid:navigator' },
  { id: 'alternate-humanoid-character', name: 'Relay', model: 'procedural-humanoid:relay' },
  { id: 'sentinel', name: 'Sentinel', model: 'procedural-humanoid:sentinel' },
  {
    id: 'quaternius-knight',
    name: 'Quaternius Knight',
    model: 'repository-model:/assets/characters/quaternius-knight/KnightCharacter.glb',
  },
  {
    id: 'quaternius-universal-base',
    name: 'Universal Base Superhero',
    model:
      'repository-model:/assets/characters/quaternius-universal-base/Superhero_Female_FullBody.gltf',
  },
];

/** The Hierarchy dock is an overlay below 900px and closed by default there. */
async function openHierarchy(page: Page): Promise<void> {
  if (!(await page.getByTestId('weapon-mode-select').isVisible())) {
    await page.getByTestId('toggle-hierarchy').click();
  }
}

/**
 * Below 900px the Hierarchy dock is a fixed overlay, so it has to be closed
 * again before anything underneath it can be clicked.
 */
async function closeHierarchy(page: Page): Promise<void> {
  if (await page.getByTestId('weapon-mode-select').isVisible()) {
    await page.getByTestId('toggle-hierarchy').click();
  }
}

/**
 * The Overview's reference list is expanded on a desktop and collapsed below
 * 900px, where it overlays the scene like every other narrow dock. The summary
 * names the Character at both widths; this opens the list.
 */
async function openOverview(page: Page): Promise<void> {
  if (!(await page.getByTestId('overview-body').isVisible())) {
    await page.getByTestId('overview-toggle').click();
  }
}

/** Closed again, so the rows below it are clickable on a narrow viewport. */
async function closeOverview(page: Page): Promise<void> {
  if (await page.getByTestId('overview-body').isVisible()) {
    await page.getByTestId('overview-toggle').click();
  }
}

test('the character list offers all five, each with its own route', async ({ page }) => {
  await page.goto('/characters');
  const list = page.getByTestId('character-list');
  await expect(list.locator('li')).toHaveCount(5);

  const hrefs = await list.locator('a').evaluateAll((links) =>
    links.map((link) => link.getAttribute('href')),
  );
  expect(new Set(hrefs).size).toBe(5);
  for (const character of CHARACTERS) {
    expect(hrefs).toContain(`/edit/rig/${character.id}`);
  }
});

test('every route resolves its own Character, and the whole page agrees', async ({ page }) => {
  /*
   * Five full page loads, two of which fetch multi-megabyte GLB models and
   * compile them under software GL. Deterministic, just genuinely slow — the
   * default 45s budget is a guess about machine speed, not about this contract.
   */
  test.setTimeout(150_000);
  for (const character of CHARACTERS) {
    await page.goto(`/edit/rig/${character.id}`);

    await expect(page.getByTestId('rig-target-id')).toContainText(character.id);
    await expect(page.getByTestId('rig-target-name')).toHaveText(character.name);
    await expect(page.getByTestId('overview-character-id')).toContainText(character.id);
    await expect(page.getByTestId('overview-character-name')).toHaveText(character.name);
    await openOverview(page);
    // The model row is the assertion that failed before: it is what the Viewport
    // draws, named in the same place as the Character it belongs to.
    await expect(page.getByTestId('overview-model')).toContainText(
      character.model.replace(/^procedural-humanoid:|^repository-model:/, ''),
    );

    await openHierarchy(page);
    await expect(page.getByTestId('hierarchy-model-binding')).toContainText(character.model);
    await closeHierarchy(page);
    await closeOverview(page);
  }
});

test('switching Character without a reload switches the model too', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto(`/edit/rig/${CHARACTERS[0]!.id}`);
  await openHierarchy(page);
  await expect(page.getByTestId('hierarchy-model-binding')).toContainText(CHARACTERS[0]!.model);
  await closeHierarchy(page);

  // Client-side navigation only — a full load re-reads the URL and cannot fail
  // the way the original bug did.
  for (const character of CHARACTERS.slice(1)) {
    await openOverview(page);
    await page.getByTestId('overview-character-switch').getByRole('button', { name: character.name }).click();
    await expect(page).toHaveURL(new RegExp(`/edit/rig/${character.id}$`));
    await expect(page.getByTestId('rig-target-id')).toContainText(character.id);
    await closeOverview(page);
    await openHierarchy(page);
    await expect(page.getByTestId('hierarchy-model-binding')).toContainText(character.model);
    await closeHierarchy(page);
  }
});

test('the Character Overview names every reference and who else holds it', async ({ page }) => {
  await page.goto('/edit/rig/demo-humanoid');
  await openOverview(page);
  const overview = page.getByTestId('character-overview');

  // Behavior: shared by all five, and the holders are listed, not just counted.
  const behavior = page.getByTestId('overview-behavior');
  await expect(behavior).toContainText('humanoid-third-person-base@1.0.0');
  // Both facts, in that order: shared by five, *and* patched locally here.
  await expect(behavior.getByTestId('ownership-badge')).toHaveText('SHARED BY 5');
  await expect(behavior.getByTestId('ownership-qualifier-badge')).toHaveText('OVERRIDDEN');
  await expect(behavior.getByTestId('ownership-holders')).toContainText('Relay');
  await expect(behavior.getByTestId('ownership-holders')).toContainText('Sentinel');

  // Rig: shared by the three procedural Characters.
  const rig = page.getByTestId('overview-rig');
  await expect(rig).toContainText('demo-humanoid-rig@1.0.0');
  await expect(rig.getByTestId('ownership-badge')).toHaveText('SHARED BY 3');

  // Motion Set: shared with Sentinel only.
  const motionSet = page.getByTestId('overview-motion-set');
  await expect(motionSet).toContainText('demo-humanoid-motion-set@1.0.0');
  await expect(motionSet.getByTestId('ownership-badge')).toHaveText('SHARED BY 2');

  // Tuning: computed, not assumed to be per-Character — four hold this one.
  const tuning = page.getByTestId('overview-tuning');
  await expect(tuning).toContainText('demo-default-tuning@1.0.0');
  await expect(tuning.getByTestId('ownership-badge')).toHaveText('SHARED BY 4');

  await expect(page.getByTestId('overview-overrides')).toContainText('2');
  await expect(page.getByTestId('overview-override-paths')).toContainText('/graph/states/walk/speed');
  await expect(overview).toContainText('Rig compatibility');
  await expect(page.getByTestId('rig-compatibility-badge')).toHaveText('COMPATIBLE');
});

test('a Character-specific reference says ONLY THIS CHARACTER', async ({ page }) => {
  await page.goto('/edit/rig/alternate-humanoid-character');
  await openOverview(page);
  const motionSet = page.getByTestId('overview-motion-set');
  await expect(motionSet).toContainText('alternate-humanoid-motion-set@1.0.0');
  await expect(motionSet.getByTestId('ownership-badge')).toHaveText('ONLY THIS CHARACTER');
  // Nothing to warn about, so there is no holder list to show.
  await expect(motionSet.getByTestId('ownership-holders')).toHaveCount(0);

  await page.goto('/edit/rig/quaternius-knight');
  await openOverview(page);
  await expect(page.getByTestId('overview-rig')).toContainText('quaternius-knight-rig@1.0.0');
  await expect(
    page.getByTestId('overview-rig').getByTestId('ownership-badge'),
  ).toHaveText('ONLY THIS CHARACTER');
});

test('the model reference opens its Asset Library detail', async ({ page }) => {
  await page.goto('/edit/rig/demo-humanoid');
  await openOverview(page);
  await page.getByTestId('overview-rig').getByRole('button', { name: /demo-humanoid-rig/ }).click();
  await expect(page.getByTestId('asset-library')).toBeVisible();
});

test('the preview override is visibly non-canonical, and resets on navigation', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/edit/rig/demo-humanoid');
  await openHierarchy(page);

  const override = page.getByTestId('preview-model-override');
  await expect(override).toContainText('PREVIEW ONLY');
  // Never labelled "Character": that is what made the old control look like the
  // Character selector.
  await expect(override).toContainText('Preview Model Override');
  await expect(override).not.toContainText(/^Character$/);

  await override.locator('summary').click();
  await page.getByTestId('preview-model-override-select').selectOption('sentinel');

  // The canonical model stays primary and is still stated as such…
  await expect(page.getByTestId('hierarchy-model-binding')).toContainText(
    'procedural-humanoid:navigator',
  );
  // …and the fact that a preview is in play is stated too, in both places.
  await expect(page.getByTestId('hierarchy-preview-badge')).toBeVisible();
  await expect(page.getByTestId('status-bar')).toContainText('Not saved to the Character');
  await closeHierarchy(page);
  await openOverview(page);
  await expect(page.getByTestId('overview-preview-badge')).toContainText('PREVIEW ONLY');

  // Navigating away and back clears it: a preview belongs to the visit.
  await page.getByTestId('overview-character-switch').getByRole('button', { name: 'Relay' }).click();
  await expect(page.getByTestId('rig-target-id')).toContainText('alternate-humanoid-character');
  await openOverview(page);
  await expect(page.getByTestId('overview-preview-badge')).toHaveCount(0);
  await closeOverview(page);
  await openHierarchy(page);
  await expect(page.getByTestId('preview-model-override-select')).toHaveValue('none');
});

test('an unknown Character id is a not-found, never a fallback', async ({ page }) => {
  await page.goto('/edit/rig/no-such-character');
  await expect(page.getByTestId('rig-target-id')).toHaveCount(0);
  await expect(page.getByText('No character "no-such-character"')).toBeVisible();
});
