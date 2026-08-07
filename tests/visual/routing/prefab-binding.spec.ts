import { expect, test, type Page } from '@playwright/test';

/**
 * The Prefab routes, under the real runner (§4, §14).
 *
 * This file used to be `character-binding.spec.ts`, and the bug it was written
 * for is worth restating because the new surface can fail the same way:
 * "selecting different entries appears to open the same rig" passed every other
 * gate — the route resolved, the header updated, the canonical document
 * changed, and the model on screen did not, because the model came from a store
 * field the route never touched.
 *
 * So the assertions are still about *agreement*: for each Prefab route, the
 * header and the Overview must name the same Prefab and the same model binding,
 * and the model must come from the Prefab's own `ModelRenderer`.
 *
 * The legacy `/edit/rig/:characterId` routes are covered here too, as what they
 * now are: redirects. The old editor must not appear on the way through.
 */

const PREFABS = [
  {
    legacyCharacterId: 'demo-humanoid',
    prefabId: 'navigator',
    name: 'Navigator',
    model: 'navigator',
  },
  {
    legacyCharacterId: 'alternate-humanoid-character',
    prefabId: 'relay',
    name: 'Relay',
    model: 'relay',
  },
  { legacyCharacterId: 'sentinel', prefabId: 'sentinel', name: 'Sentinel', model: 'sentinel' },
  {
    legacyCharacterId: 'quaternius-knight',
    prefabId: 'quaternius-knight',
    name: 'Quaternius Knight',
    model: '/assets/characters/quaternius-knight/KnightCharacter.glb',
  },
  {
    legacyCharacterId: 'quaternius-universal-base',
    prefabId: 'quaternius-universal-base',
    name: 'Universal Base Superhero',
    model: '/assets/characters/quaternius-universal-base/Superhero_Female_FullBody.gltf',
  },
];

async function openPrefab(page: Page, prefabId: string): Promise<void> {
  await page.goto(`/edit/prefab/${prefabId}`);
  await expect(page.getByTestId('prefab-target-id')).toContainText(prefabId);
}

test('the Prefab list offers every Prefab, each with its own route', async ({ page }) => {
  await page.goto('/prefabs');
  const list = page.getByTestId('prefab-list');
  await expect(list).toBeVisible();

  const hrefs = await list
    .locator('a')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  for (const prefab of PREFABS) {
    expect(hrefs).toContain(`/edit/prefab/${prefab.prefabId}`);
  }
  // Id *and* exact version, because a lineage and a version are two identities
  // and the usage counts beside them belong to the version.
  await expect(page.getByTestId('prefab-row-reference-navigator')).toContainText('navigator@');
});

test('the Characters filter admits compositions, not names', async ({ page }) => {
  await page.goto('/prefabs');
  await page.getByTestId('prefab-filter-characters').click();
  await expect(page.getByTestId('prefab-row-navigator')).toBeVisible();
  // A camera Prefab has neither Animator nor motor, whatever it is called.
  await expect(page.getByTestId('prefab-row-default-scene-camera')).toHaveCount(0);

  await page.getByTestId('prefab-filter-cameras').click();
  await expect(page.getByTestId('prefab-row-default-scene-camera')).toBeVisible();
  await expect(page.getByTestId('prefab-row-navigator')).toHaveCount(0);
});

test('every Prefab route resolves its own Prefab, and the page agrees', async ({ page }) => {
  /*
   * Five full page loads, two of which fetch multi-megabyte GLB models and
   * compile them under software GL. Deterministic, just genuinely slow.
   */
  test.setTimeout(150_000);
  for (const prefab of PREFABS) {
    await openPrefab(page, prefab.prefabId);
    await expect(page.getByTestId('prefab-target-name')).toHaveText(prefab.name);
    // The model row is the assertion that failed before: it is what the
    // Viewport draws, named beside the Prefab it belongs to — and it comes from
    // the Prefab's ModelRenderer, not from a catalog keyed by id.
    await expect(page.getByTestId('prefab-overview-models')).toContainText(prefab.model);
  }
});

test('the Prefab Editor shows the composition, not a Character', async ({ page }) => {
  await openPrefab(page, 'navigator');
  await expect(page.getByTestId('prefab-hierarchy-panel')).toBeVisible();
  await expect(page.getByTestId('prefab-components-panel')).toBeVisible();
  await expect(page.getByTestId('prefab-inspector-panel')).toBeVisible();
  await expect(page.getByTestId('prefab-viewport-panel')).toBeVisible();
  await expect(page.getByTestId('prefab-usage-panel')).toBeVisible();
  await expect(page.getByTestId('prefab-dependencies-panel')).toBeVisible();
  await expect(page.getByTestId('prefab-version-panel')).toBeVisible();

  await expect(page.getByTestId('prefab-overview-components')).toContainText('animator');
  await expect(page.getByTestId('prefab-overview-components')).toContainText('character-motor');
  // Derivation is authored, and stated: navigator is a variant of the base.
  await expect(page.getByTestId('prefab-overview-parent')).toContainText('humanoid-character-base');
});

test('selecting the Animator opens the animation authoring workspace', async ({ page }) => {
  test.setTimeout(90_000);
  await openPrefab(page, 'navigator');
  await page.getByTestId('prefab-component-animator').click();
  await expect(page).toHaveURL(/component=animator/);
  await expect(page.getByTestId('prefab-animator-assignment')).toContainText(
    'humanoid-third-person-base@',
  );
  // The existing workspace, mounted — not a second graph editor.
  await expect(page.getByTestId('prefab-animation-workspace')).toBeVisible();
  await expect(page.getByTestId('hud')).toBeVisible();
});

test('Usage names the exact Scene instances standing on this version', async ({ page }) => {
  await openPrefab(page, 'navigator');
  const usage = page.getByTestId('prefab-usage-panel');
  await expect(usage).toContainText('controlled-humanoid');
  await expect(usage).toContainText('scripted-humanoid');
});

test('an unknown Prefab id is a not-found, never a fallback', async ({ page }) => {
  await page.goto('/edit/prefab/no-such-prefab');
  await expect(page.getByTestId('prefab-target-id')).toHaveCount(0);
  await expect(page.getByText('No Prefab "no-such-prefab"')).toBeVisible();
});

test('every legacy rig route redirects to the Prefab its Character became', async ({ page }) => {
  test.setTimeout(150_000);
  for (const prefab of PREFABS) {
    await page.goto(`/edit/rig/${prefab.legacyCharacterId}`);
    await expect(page).toHaveURL(
      new RegExp(`/edit/prefab/${prefab.prefabId}/animation/[^/]+/[^/]+$`),
    );
    await expect(page.getByTestId('animation-subject-prefab')).toContainText(prefab.prefabId);
    // The old editor must not have mounted on the way through.
    await expect(page.getByTestId('rig-target-header')).toHaveCount(0);
  }
});

test('an unmapped legacy character id is a not-found, not a guess', async ({ page }) => {
  await page.goto('/edit/rig/no-such-character');
  await expect(page.getByTestId('route-not-found')).toBeVisible();
  await expect(page.getByTestId('prefab-target-id')).toHaveCount(0);
});

/*
 * Coverage this file lost in the cutover, stated rather than quietly dropped.
 *
 * The Character Overview asserted asset sharing — SHARED BY 5, the holder list,
 * the override count, rig compatibility — and the preview-model override's
 * "PREVIEW ONLY / resets on navigation" contract. Both belong on the Prefab
 * Overview, which does not carry them yet: it names references and holders but
 * not per-reference ownership badges, and the Prefab Editor has no preview
 * override control of its own.
 *
 * They are `fixme` rather than deleted because the contracts still hold in the
 * canonical data — what is missing is the surface that states them.
 */
test.fixme('the Prefab Overview names every reference and who else holds it', async () => {});
test.fixme('the preview override is visibly non-canonical, and resets on navigation', async () => {});
