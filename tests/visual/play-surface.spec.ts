import { expect, test } from '@playwright/test';

test('root play surface accepts human input and runs Air Dash through Gameplay Script', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('play-canvas')).toBeVisible();
  await expect(page.getByTestId('game-overlay')).toBeVisible();
  await expect(page.getByTestId('scene-editor')).toHaveCount(0);

  const before = await page.evaluate(() => window.__ATC_TEST__!.getPlayCharacterSnapshot('controlled-humanoid'));
  await page.keyboard.down('KeyW');
  await expect.poll(async () => (await page.evaluate(() => window.__ATC_TEST__!.getPlayCharacterSnapshot('controlled-humanoid')))?.worldTransform.position.z).not.toBe(before?.worldTransform.position.z);
  await page.keyboard.up('KeyW');

  await page.evaluate(() => {
    window.__ATC_TEST__!.enablePlay();
    window.__ATC_TEST__!.sendPlayEvent('controlled-humanoid', 'dash');
    window.__ATC_TEST__!.advancePlayTicks(2);
  });
  const queued = await page.evaluate(() => window.__ATC_TEST__!.getPlayCharacterSnapshot('controlled-humanoid'));
  expect(queued?.activeMotionOverrides.some((entry) => entry.key === 'dash')).toBe(true);
  expect(queued?.gameplayParameters['gameplay.dashing']).toBe(true);
  await page.evaluate(() => window.__ATC_TEST__!.advancePlayTicks(20));
  const expired = await page.evaluate(() => window.__ATC_TEST__!.getPlayCharacterSnapshot('controlled-humanoid'));
  expect(expired?.activeMotionOverrides).toEqual([]);
  expect(expired?.gameplayParameters['gameplay.dashing']).toBeUndefined();
});

test('explicit unknown play route refuses without fallback', async ({ page }) => {
  await page.goto('/play/no-such-scene');
  await expect(page.getByTestId('play-surface')).toContainText('no-such-scene');
  await expect(page.getByTestId('play-canvas')).toHaveCount(0);
});
