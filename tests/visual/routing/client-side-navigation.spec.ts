import { expect, test, type Page } from '@playwright/test';

/**
 * Client-side navigation, under the real runner (work package §12).
 *
 * These exist because a navigation bug survived every other gate. The pathname
 * changed, no error was logged, the unit tests passed, and manual clicking in a
 * desktop browser looked correct — while the route component kept rendering the
 * previous target indefinitely. Only a real browser driving the real router
 * catches that, and only if the assertion checks the *rendered target* rather
 * than the URL.
 *
 * So each test asserts three things, and the first one alone would have passed
 * against the bug:
 *
 *   the pathname moved              — `history.pushState` did its job
 *   the route target ID moved       — the router re-rendered the route
 *   the resolved data moved         — the page rebuilt from the new target
 *
 * `page.goto` is deliberately not used to reach the second route: a full page
 * load re-reads the URL from scratch and cannot fail the way this did, so a
 * test that navigated with `goto` would assert nothing about the contract that
 * broke.
 */

const CHARACTER_A = 'demo-humanoid';
const CHARACTER_B = 'alternate-humanoid-character';

async function openRigEditor(page: Page, characterId: string): Promise<void> {
  await page.goto(`/edit/rig/${characterId}`);
  await expect(page.getByTestId('rig-target-id')).toContainText(characterId);
}

test.describe('client-side navigation', () => {
  test('a plain router Link moves the route target, not only the URL', async ({ page }) => {
    await openRigEditor(page, CHARACTER_A);

    await page.getByRole('link', { name: 'Alternate humanoid' }).click();

    await expect(page).toHaveURL(new RegExp(`/edit/rig/${CHARACTER_B}$`));
    // The assertion that actually failed: the URL moved and this did not.
    await expect(page.getByTestId('rig-target-id')).toContainText(CHARACTER_B);
    // And the switcher now offers the character we came *from*, which it can
    // only do if the page rebuilt its target from the new route parameter.
    await expect(page.getByRole('link', { name: 'Procedural Humanoid' })).toBeVisible();
  });

  test('the Asset Library character select navigates and the library follows', async ({ page }) => {
    await openRigEditor(page, CHARACTER_A);
    await page.getByTestId('workspace-asset-library').click();
    await expect(page.getByTestId('asset-library')).toBeVisible();

    await page.getByTestId('library-character-select').selectOption(CHARACTER_B);

    await expect(page).toHaveURL(new RegExp(`/edit/rig/${CHARACTER_B}$`));
    await expect(page.getByTestId('rig-target-id')).toContainText(CHARACTER_B);
    // The library is docked inside the route, so its resolved data has to move
    // with the route rather than keeping the character it was opened on.
    await expect(page.getByTestId('library-character-select')).toHaveValue(CHARACTER_B);
  });

  test('browser Back returns to the previous route target', async ({ page }) => {
    await openRigEditor(page, CHARACTER_A);
    await page.getByRole('link', { name: 'Alternate humanoid' }).click();
    await expect(page.getByTestId('rig-target-id')).toContainText(CHARACTER_B);

    // Back is the same subscription by a different route in: a popstate the
    // router has to hear. It was equally dead while the location update was a
    // starved transition.
    await page.goBack();

    await expect(page).toHaveURL(new RegExp(`/edit/rig/${CHARACTER_A}$`));
    await expect(page.getByTestId('rig-target-id')).toContainText(CHARACTER_A);
  });

  test('navigating between the scene list and a scene editor rebuilds the page', async ({ page }) => {
    await page.goto('/scenes');
    const sceneLink = page.locator('a[href^="/edit/scene/"]').first();
    const href = await sceneLink.getAttribute('href');
    const sceneId = href!.replace('/edit/scene/', '');

    await sceneLink.click();

    await expect(page).toHaveURL(new RegExp(`/edit/scene/${sceneId}$`));
    await expect(page.getByTestId('scene-target-id')).toContainText(sceneId);
  });
});
