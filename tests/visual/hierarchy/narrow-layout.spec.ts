import { expect, test } from '@playwright/test';

/**
 * The 320px layout, asserted where it means something.
 *
 * The claim is not that everything is visible at once — it cannot be — but
 * that every dock is reachable, that the selection survives the docks opening
 * and closing, and that nothing overflows the viewport horizontally.
 */
test.describe('narrow layout', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'narrow', 'this is the 320px layout test');
  });

  test('hierarchy, inspector and workspaces are each reachable at 320px', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__ATC_TEST__));
    await page.evaluate(() => window.__ATC_TEST__!.enableWorld());

    const noOverflow = async () => {
      const [scrollWidth, clientWidth] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    };
    await noOverflow();

    // The hierarchy opens as an overlay, and a selection made in it survives
    // the overlay closing — that is the selection model doing its job.
    await page.getByTestId('toggle-hierarchy').click();
    await expect(page.getByTestId('hierarchy')).toBeVisible();
    await page.getByTestId('scene-node-instance-scripted-humanoid').click();
    await noOverflow();
    await page.getByTestId('toggle-hierarchy').click();
    await expect(page.getByTestId('hierarchy')).toBeHidden();

    // The Inspector opens over the viewport and still shows that selection.
    await page.getByTestId('sheet-handle').click();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');
    await noOverflow();

    // And closes again, releasing the viewport controls underneath it.
    await page.getByTestId('sheet-handle').click();
    await page.getByTestId('toggle-pause').click();
    await expect(page.getByTestId('toggle-pause')).toHaveText('Resume motion');

    // The bottom workspaces are reachable, and take the screen from the sheet.
    await page.getByTestId('workspace-asset-library').click();
    await expect(page.getByTestId('workspace-dock')).toBeVisible();
    await page.getByTestId('workspace-animation-preview').click();
    await expect(page.getByTestId('animation-preview')).toBeVisible();
    await noOverflow();

    // Closing the dock brings the sheet handle back, and the selection is
    // still the one made before any of this.
    await page.getByTestId('workspace-chamber').click();
    await page.getByTestId('sheet-handle').click();
    await expect(page.getByTestId('world-inspector-id')).toHaveText('scripted-humanoid');
    await noOverflow();
  });
});
