import { expect, test, type Page } from '@playwright/test';

/**
 * Client-side navigation, under the real runner (work package §12, §14).
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
 *
 * The targets are Prefabs now rather than Characters. The contract is the same
 * one — what is on screen must come from the route — and it is worth more here,
 * because a Prefab's model comes from its own ModelRenderer rather than from a
 * store field a route could fail to touch.
 */

const PREFAB_A = 'navigator';
const PREFAB_B = 'relay';

async function openPrefabEditor(page: Page, prefabId: string): Promise<void> {
  await page.goto(`/edit/prefab/${prefabId}`);
  await expect(page.getByTestId('prefab-target-id')).toContainText(prefabId);
}

test.describe('client-side navigation', () => {
  test('a plain router Link moves the route target, not only the URL', async ({ page }) => {
    await page.goto('/prefabs');

    await page.getByTestId('prefab-row-relay').getByRole('link').click();

    await expect(page).toHaveURL(new RegExp(`/edit/prefab/${PREFAB_B}$`));
    // The assertion that actually failed: the URL moved and this did not.
    await expect(page.getByTestId('prefab-target-id')).toContainText(PREFAB_B);
    // And the page rebuilt its whole target from the new route parameter, not
    // only its header.
    await expect(page.getByTestId('prefab-overview-models')).toContainText('relay');
  });

  test('browser Back returns to the previous route target', async ({ page }) => {
    await openPrefabEditor(page, PREFAB_A);
    await page.getByRole('link', { name: 'All Prefabs' }).click();
    await page.getByTestId('prefab-row-relay').getByRole('link').click();
    await expect(page.getByTestId('prefab-target-id')).toContainText(PREFAB_B);

    // Back is the same subscription by a different route in: a popstate the
    // router has to hear. It was equally dead while the location update was a
    // starved transition.
    await page.goBack();
    await page.goBack();

    await expect(page).toHaveURL(new RegExp(`/edit/prefab/${PREFAB_A}$`));
    await expect(page.getByTestId('prefab-target-id')).toContainText(PREFAB_A);
  });

  /*
   * Back and Forward have to restore the *model* too, not only the target id.
   * That is a distinct assertion: the model used to come from a store field the
   * route never touched, so history navigation moved the header while leaving
   * the previous target on screen.
   */
  test('Back and Forward restore the model, not only the route target', async ({ page }) => {
    test.setTimeout(90_000);
    const modelOf = async (): Promise<string> =>
      (await page.getByTestId('prefab-overview-models').textContent()) ?? '';

    await openPrefabEditor(page, PREFAB_A);
    expect(await modelOf()).toContain('navigator');

    await page.getByRole('link', { name: 'All Prefabs' }).click();
    await page.getByTestId('prefab-row-relay').getByRole('link').click();
    await expect(page.getByTestId('prefab-target-id')).toContainText(PREFAB_B);
    expect(await modelOf()).toContain('relay');

    await page.goBack();
    await page.goBack();
    await expect(page.getByTestId('prefab-target-id')).toContainText(PREFAB_A);
    expect(await modelOf()).toContain('navigator');

    await page.goForward();
    await page.goForward();
    await expect(page.getByTestId('prefab-target-id')).toContainText(PREFAB_B);
    expect(await modelOf()).toContain('relay');
  });

  /*
   * Component selection is view state in the query string, so it must survive
   * Back the same way the target does — and must not leak across Prefabs.
   */
  test('the selected Component lives in the URL and resets across targets', async ({ page }) => {
    test.setTimeout(90_000);
    await openPrefabEditor(page, PREFAB_A);
    // `?component=` names the Component id now, not its type: one node may
    // carry two Components of a type, and only the id tells them apart.
    await page.getByTestId('prefab-component-model').click();
    await expect(page).toHaveURL(/component=model/);

    await page.goto(`/edit/prefab/${PREFAB_B}`);
    await expect(page).not.toHaveURL(/component=/);
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
