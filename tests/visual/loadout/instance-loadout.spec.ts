import { expect, test, type Page } from '@playwright/test';

/**
 * Two instances of one character, given different loadouts, through the UI.
 *
 * The command-level version of this lives in
 * `tests/integration/world/instance-loadout.test.ts`. This one exists because
 * the failure being guarded against was never in the runtime — it was that the
 * *control* had no instance in it. A test that only exercised the commands
 * would pass happily while the panel went on calling a global setter.
 */

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__ATC_TEST__));
  await page.evaluate(() => window.__ATC_TEST__!.enableWorld());
  if (!(await page.getByTestId('hierarchy').isVisible())) {
    await page.getByTestId('toggle-hierarchy').click();
  }
  const handle = page.getByTestId('sheet-handle');
  if (await handle.isVisible()) {
    const panels = page.locator('.app__panels');
    if (!(await panels.evaluate((element) => element.classList.contains('is-open')))) {
      await handle.click();
    }
  }
}

async function select(page: Page, instanceId: string): Promise<void> {
  await page.getByTestId(`scene-node-instance-${instanceId}`).click();
  await expect(page.getByTestId('world-inspector-id')).toHaveText(instanceId);
}

test.describe('instance loadout', () => {
  test('equipping the shield on one instance leaves its sibling alone', async ({ page }) => {
    await open(page);

    // The project's shield slot defaults to unequipped, so equipping it is the
    // edit that creates an override. Which direction the override goes in is
    // not the point; that it reaches exactly one instance is.
    await select(page, 'controlled-humanoid');
    const shield = page.getByTestId('loadout-equipment-shield-input');
    await expect(shield).not.toBeChecked();
    await shield.check();
    await expect(page.getByTestId('loadout-equipment-shield-scope')).toContainText(
      'effective: equipped',
    );

    // The sibling shares the character definition and must be untouched.
    await select(page, 'scripted-humanoid');
    await expect(page.getByTestId('loadout-equipment-shield-input')).not.toBeChecked();
    await expect(page.getByTestId('loadout-equipment-shield-scope')).toContainText(
      'Definition default: not equipped',
    );

    // Back on the edited one: the override survived the round trip.
    await select(page, 'controlled-humanoid');
    await expect(page.getByTestId('loadout-equipment-shield-input')).toBeChecked();
  });

  test('the hierarchy row shows override state, and only for the overridden instance', async ({
    page,
  }) => {
    await open(page);
    await select(page, 'controlled-humanoid');
    await page.getByTestId('loadout-equipment-shield-input').check();

    await expect(page.getByTestId('scene-node-attachment-controlled-humanoid-shield')).toContainText(
      'Override',
    );
    await expect(
      page.getByTestId('scene-node-attachment-scripted-humanoid-shield'),
    ).not.toContainText('Override');
  });

  test('resetting an override restores the definition default rather than a value', async ({
    page,
  }) => {
    await open(page);
    await select(page, 'controlled-humanoid');
    await page.getByTestId('loadout-equipment-shield-input').check();
    await expect(page.getByTestId('loadout-equipment-shield-reset')).toBeEnabled();

    await page.getByTestId('loadout-equipment-shield-reset').click();
    await expect(page.getByTestId('loadout-equipment-shield-input')).not.toBeChecked();
    // Reset means "no override", so the button disables itself again.
    await expect(page.getByTestId('loadout-equipment-shield-reset')).toBeDisabled();
    await expect(
      page.getByTestId('scene-node-attachment-controlled-humanoid-shield'),
    ).not.toContainText('Override');
  });

  test('weapon mode targets one instance and badges it', async ({ page }) => {
    await open(page);
    await select(page, 'scripted-humanoid');
    await page.getByTestId('loadout-weapon-mode-input').selectOption('sword');
    await expect(page.getByTestId('scene-node-instance-scripted-humanoid')).toContainText('sword');

    await select(page, 'controlled-humanoid');
    await expect(page.getByTestId('loadout-weapon-mode-input')).toHaveValue('unarmed');
    await expect(page.getByTestId('scene-node-instance-controlled-humanoid')).not.toContainText(
      'sword',
    );
  });

  test('an undo restores the loadout the instance had', async ({ page }) => {
    await open(page);
    await select(page, 'scripted-humanoid');
    await page.getByTestId('loadout-weapon-mode-input').selectOption('sword');
    await expect(page.getByTestId('loadout-weapon-mode-input')).toHaveValue('sword');

    // Staged world edits revert as a unit, from the world root that owns them.
    await page.getByTestId('scene-node-world').click();
    await page.getByTestId('world-revert').click();

    await select(page, 'scripted-humanoid');
    await expect(page.getByTestId('loadout-weapon-mode-input')).toHaveValue('unarmed');
  });

  test('selecting the shield opens the attachment inspector with its parent visible', async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId('scene-node-attachment-controlled-humanoid-shield').click();

    await expect(page.getByTestId('attachment-inspector')).toBeVisible();
    await expect(page.getByTestId('attachment-slot-id')).toHaveText('shield');
    await expect(page.getByTestId('attachment-parent-instance')).toHaveText('Controlled humanoid');

    // The toggle here edits the same instance override the Loadout section does.
    await page.getByTestId('attachment-equipped-input').check();
    await expect(page.getByTestId('attachment-scope-explanation')).toContainText(
      'this instance: equipped',
    );
    await page.getByTestId('attachment-parent-instance').click();
    await expect(page.getByTestId('loadout-equipment-shield-input')).toBeChecked();
  });
});
