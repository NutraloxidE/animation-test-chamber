import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * These tests drive the chamber the way a human does: open a panel, move a
 * value, watch the character react, stage the change, commit it. They assert on
 * behaviour rather than on pixels, so they fail when the loop breaks rather than
 * when a colour changes.
 */

async function openPanel(page: Page, id: string): Promise<void> {
  const handle = page.getByTestId('sheet-handle');
  // The bottom sheet only exists on narrow viewports.
  if (await handle.isVisible()) {
    const panels = page.locator('.app__panels');
    if (!(await panels.evaluate((element) => element.classList.contains('is-open')))) {
      await handle.click();
    }
  }
  await page.getByTestId(`tab-${id}`).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('hud')).toBeVisible();
});

test('boots with the demo project and a running simulation', async ({ page }) => {
  await expect(page.locator('canvas')).toBeVisible();

  // The tick counter proves the fixed-step loop is actually advancing.
  const hud = page.getByTestId('hud');
  const firstTick = await hud.textContent();
  await page.waitForTimeout(600);
  expect(await hud.textContent()).not.toBe(firstTick);
});

test('the character responds to keyboard input', async ({ page }) => {
  const hud = page.getByTestId('hud');
  await expect(hud).toContainText('idle');

  await page.locator('canvas').click({ position: { x: 200, y: 200 } });
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(700);
  await expect(hud).toContainText(/walk|run/);
  await page.keyboard.up('KeyW');

  await page.waitForTimeout(900);
  await expect(hud).toContainText('idle');
});

test('camera control switches between mouse movement and click-drag', async ({ page }) => {
  const toggle = page.getByTestId('toggle-camera-control');
  await expect(toggle).toHaveText('Camera: Mouse move');
  await toggle.click();
  await expect(toggle).toHaveText('Camera: Click-drag');
  await toggle.click();
  await expect(toggle).toHaveText('Camera: Mouse move');
});

test('character, motion and weapon presets can be selected', async ({ page }) => {
  await page.getByTestId('character-select').selectOption('quaternius-universal-base');
  await expect(page.getByTestId('status-bar')).toContainText('Universal Base Superhero');
  await page.getByTestId('motion-set-select').selectOption('power');
  await expect(page.getByTestId('status-bar')).toContainText('Power stride');
  const swordAsset = page.waitForResponse((response) =>
    response.url().endsWith('/assets/animations/quaternius-universal-2/UAL2_Standard_RM.glb'),
  );
  await page.getByTestId('weapon-mode-select').selectOption('sword');
  expect((await swordAsset).ok()).toBe(true);
  await expect(page.getByTestId('status-bar')).toContainText('Sword');
  await page.getByTestId('grip-editor-select').selectOption('rotate');
  await expect(page.getByTestId('reset-grip')).toBeVisible();
  await expect(page.getByTestId('mobile-pad')).toBeHidden();
  await expect(page.getByTestId('status-bar')).toContainText('auto-save');
  await expect(page.getByTestId('frame-step')).toBeDisabled();
  await page.getByTestId('toggle-pause').click();
  await expect(page.getByTestId('toggle-pause')).toHaveText('Resume motion');
  await expect(page.getByTestId('frame-step')).toBeEnabled();
  await page.getByTestId('frame-step').click();
  await page.getByTestId('viewport-controls').getByText('Controls').click();
  await expect(page.getByTestId('character-select')).toBeHidden();
});

test('jump and attack drive the two layers independently', async ({ page }) => {
  const hud = page.getByTestId('hud');
  await page.locator('canvas').click({ position: { x: 200, y: 200 } });

  await page.keyboard.press('Space');
  // The HUD samples on an interval, so the airborne window can be missed on a
  // slow run. `land` is equally proof that the jump fired, and is not transient.
  await expect(hud).toContainText(/jump|fall|land/);

  await page.waitForTimeout(1200);
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(200);
  await expect(hud).toContainText('attack-01');
});

test('sword attacks play their matching recovery clips', async ({ page }) => {
  const hud = page.getByTestId('hud');
  await page.getByTestId('character-select').selectOption('quaternius-universal-base');
  await page.getByTestId('weapon-mode-select').selectOption('sword');

  await openPanel(page, 'replay');
  const replaySelect = page.getByTestId('replay-panel').locator('select').first();
  await replaySelect.selectOption('run-to-attack-forward');
  await page.getByTestId('play-replay').click();
  await expect(hud).toContainText('attack-01-recovery', { timeout: 2500 });
  await expect(hud).toContainText('action-none', { timeout: 2500 });

  await page.getByTestId('replay-panel').locator('select').first().selectOption('attack-01-to-attack-02');
  await page.getByTestId('play-replay').click();
  await expect(hud).toContainText('attack-02', { timeout: 1500 });
  await expect(hud).toContainText('attack-02-recovery', { timeout: 2500 });
  await expect(hud).toContainText('action-none', { timeout: 2500 });

  await openPanel(page, 'inspector');
  await page.getByTestId('blend-list').click();
  await expect(page.getByTestId('blend-attack-01-to-recovery')).toBeVisible();
  await expect(page.getByTestId('blend-attack-01-recovery-to-none')).toBeVisible();
  await expect(page.getByTestId('blend-attack-02-to-recovery')).toBeVisible();
  await expect(page.getByTestId('blend-attack-02-recovery-to-none')).toBeVisible();
});

test('editing a transition updates the preview and the diff', async ({ page }) => {
  await openPanel(page, 'inspector');
  await expect(page.getByTestId('transition-inspector')).toBeVisible();

  const blend = page.getByTestId('field-/graph/transitions/run-to-attack-01/blendDurationSec');
  await expect(blend).toBeVisible();
  await expect(blend).toContainText('repository');

  const slider = blend.locator('input[type=range]');
  await slider.fill('0.08');

  // Origin flips to a human preview as soon as the value diverges.
  await expect(blend).toContainText('human preview');

  await openPanel(page, 'diff');
  await expect(page.getByTestId('diff-panel')).toContainText('blendDurationSec');
});

test('repeated clip tuning is exposed through the Inspector edit loop', async ({ page }) => {
  await openPanel(page, 'inspector');
  await page.getByTestId('clip-select').selectOption('attack-01');
  await expect(page.getByTestId('field-/clips/attack-01/rootDisplacement/z')).toContainText(
    'Forward displacement adjustment',
  );
  await expect(page.getByTestId('field-/clips/attack-01/rootDisplacement/z')).toContainText('+0.00 m');
  await expect(page.getByTestId('field-/clips/attack-01/inputAcceptanceStartNormalized')).toContainText('20%');
  await page.getByTestId('action-input-list').click();
  await expect(page.getByTestId('action-input-attack-01')).toBeVisible();
  await expect(page.getByTestId('action-input-attack-01-recovery')).toContainText('85%');

  await openPanel(page, 'replay');
  await page.getByTestId('replay-panel').locator('select').first().selectOption('run-to-attack-forward');
  await page.getByTestId('play-replay').click();
  await openPanel(page, 'inspector');
  await page.getByTestId('clip-select').selectOption('attack-01');
  await page.getByTestId('action-input-list').click();
  const liveAttack = page.getByTestId('action-input-attack-01').locator('..');
  await expect(liveAttack).toHaveClass(/blend-row--live/);
  await expect(liveAttack).toContainText('PLAYING');
  await expect(page.getByTestId('selected-action-playback')).toContainText('PLAYING');
  await expect.poll(async () => Number(await liveAttack.getAttribute('data-progress'))).toBeGreaterThan(0);
  await page.getByTestId('clip-select').selectOption('dodge');

  const distance = page.getByTestId('field-/clips/dodge/rootDisplacement/z');
  await expect(distance).toBeVisible();
  await expect(distance).toContainText('5.5 m');
  await expect(page.getByTestId('field-/clips/dodge/recoveryTransitionStartNormalized')).toContainText('0.720');
  await distance.locator('input[type=range]').fill('6.2');
  await expect(distance).toContainText('human preview');
  await distance.getByRole('button', { name: 'stage', exact: true }).click();
  await expect(distance).toContainText('human final (staged)');

  await page.reload();
  await openPanel(page, 'inspector');
  await page.getByTestId('clip-select').selectOption('dodge');
  await expect(page.getByTestId('field-/clips/dodge/rootDisplacement/z')).toContainText('6.2 m');

  await openPanel(page, 'diff');
  await expect(page.getByTestId('diff-panel')).toContainText('rootDisplacement');
});

test('a locked value cannot be edited until it is explicitly unlocked', async ({ page }) => {
  await openPanel(page, 'terrain');
  const jumpHeight = page.getByTestId('field-/movement/jumpHeight');
  await jumpHeight.scrollIntoViewIfNeeded();

  await expect(jumpHeight).toContainText('locked');
  await expect(jumpHeight.locator('input[type=range]')).toBeDisabled();

  await jumpHeight.getByRole('button', { name: /unlock/i }).click();
  await expect(jumpHeight.locator('input[type=range]')).toBeEnabled();
});

test('the AI panel returns three proposals with no API key configured', async ({ page }) => {
  await openPanel(page, 'ai');
  await page.getByTestId('request-proposals').click();

  const panel = page.getByTestId('ai-panel');
  await expect(panel).toContainText('rule-based', { timeout: 15_000 });
  await expect(panel.locator('.proposal')).toHaveCount(3);

  // The locked field is named as untouched in every variant.
  await expect(panel).toContainText('Left untouched (protected)');
  await expect(panel).toContainText('momentumRetention');
});

test.describe('committing', () => {
  // This test performs a real commit, and the API writes the result back to the
  // canonical file. Snapshot and restore it so running the suite does not leave
  // an extra revision in the working tree.
  const PROJECT_PATH = resolve(here, '../../projects/demo-character/project.json');
  let original: string;

  test.beforeAll(() => {
    original = readFileSync(PROJECT_PATH, 'utf8');
  });

  test.afterAll(() => {
    writeFileSync(PROJECT_PATH, original, 'utf8');
  });

  test('the full stage, validate and commit loop works with the fake Git adapter', async ({ page }) => {
    await openPanel(page, 'inspector');

    await page.getByTestId('clip-select').selectOption('dodge');
    await page.getByTestId('field-/clips/dodge/rootDisplacement/z').locator('input[type=range]').fill('6.2');

    await openPanel(page, 'diff');
    await page.getByTestId('stage-all').click();

    const commit = page.getByTestId('commit-button');
    await expect(commit).toBeEnabled();
    await commit.click();

    await expect(page.getByTestId('status-bar')).toContainText(/Committed [0-9a-f]{8} to chamber\//, {
      timeout: 15_000,
    });

    const saved = JSON.parse(readFileSync(PROJECT_PATH, 'utf8')) as {
      clips: { id: string; rootDisplacement: { z: number } }[];
    };
    expect(saved.clips.find((clip) => clip.id === 'dodge')?.rootDisplacement.z).toBe(6.2);
  });
});

test('a replay plays back and reports a before/after comparison', async ({ page }) => {
  await openPanel(page, 'replay');
  await expect(page.getByTestId('replay-panel')).toBeVisible();

  await page.getByTestId('play-replay').click();
  await expect(page.getByTestId('hud')).toContainText('replay', {
    timeout: 10_000,
  });

  await expect(page.getByTestId('replay-panel')).toContainText('Foot sliding');
});

test('the state graph reports no unreachable states or priority conflicts', async ({ page }) => {
  await openPanel(page, 'graph');
  const graph = page.getByTestId('state-graph');
  await expect(graph).toContainText('No unreachable states, priority conflicts or illegal self-loops');
  await expect(page.getByTestId('graph-live-locomotion')).toContainText('idle');
  await expect(page.getByTestId('layer-mix')).toContainText('LOCOMOTION 100%');
  await expect(page.getByTestId('layer-mix')).toContainText('ACTION 0%');
  await expect(page.getByTestId('layer-mix').locator('.layer-mix__action--action-none')).toHaveAttribute(
    'data-weight',
    '0.000',
  );

  await page.keyboard.down('KeyW');
  await expect(page.getByTestId('graph-live-locomotion')).toContainText(/walk|run/);
  await expect(graph.locator('.graph-layer').first().locator('.graph-node.is-active')).toContainText(/walk|run/);
  await page.keyboard.press('ShiftLeft');
  await expect
    .poll(async () => Number(await graph.locator('.layer-mix__action').getAttribute('data-weight')))
    .toBeGreaterThan(0);
  await page.keyboard.up('KeyW');
});

test('the layer bar colours action-to-action blends', async ({ page }) => {
  await openPanel(page, 'inspector');
  await page.getByTestId('transition-select').selectOption('attack-01-to-attack-02');
  await page
    .getByTestId('field-/graph/transitions/attack-01-to-attack-02/blendDurationSec')
    .locator('input[type=range]')
    .fill('0.5');

  await openPanel(page, 'graph');
  await page.locator('canvas').click({ position: { x: 200, y: 200 } });
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(350);
  await page.keyboard.press('KeyJ');

  const gauge = page.getByTestId('layer-mix');
  await expect(page.getByTestId('graph-live-action')).toContainText('attack-02');
  await expect(gauge.locator('[data-state="attack-01"]')).toBeVisible();
  await expect(gauge.locator('[data-state="attack-02"]')).toBeVisible();
  await expect(gauge.locator('[data-state="attack-01"]')).toHaveCSS('background-color', 'rgb(251, 191, 36)');
  await expect(gauge.locator('[data-state="attack-02"]')).toHaveCSS('background-color', 'rgb(192, 132, 252)');
});

test('the timeline shows the semantic event and cancel window tracks', async ({ page }) => {
  await openPanel(page, 'graph');
  await page.getByRole('button', { name: 'attack-01', exact: true }).click();

  await openPanel(page, 'timeline');
  const timeline = page.getByTestId('timeline');
  await expect(timeline).toContainText('Semantic Events');
  await expect(timeline).toContainText('Cancel Window');
  await expect(timeline).toContainText('Haptics');
  await expect(timeline.locator('.marker').first()).toBeVisible();
});

test('timing curve control points can be dragged directly', async ({ page }) => {
  await openPanel(page, 'timing');
  const graph = page.getByTestId('timing-curve');
  const control = page.getByTestId('timing-control-1');
  await control.scrollIntoViewIfNeeded();
  const graphBox = await graph.boundingBox();
  const controlBox = await control.boundingBox();
  expect(graphBox).not.toBeNull();
  expect(controlBox).not.toBeNull();

  await page.mouse.move(controlBox!.x + controlBox!.width / 2, controlBox!.y + controlBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    Math.min(graphBox!.x + graphBox!.width - 12, controlBox!.x + graphBox!.width * 0.2),
    Math.max(graphBox!.y + 12, controlBox!.y - graphBox!.height * 0.15),
    { steps: 4 },
  );
  await page.mouse.up();

  expect(await page.getByTestId('timing-value-x1').textContent()).not.toBe('0.25');
  await page.getByTestId('timing-stage').click();
  await expect(page.getByTestId('timing-stage')).toHaveText('✓ Staged');
  await expect(page.getByTestId('timing-stage-status')).toHaveText('Saved to staged draft');

  await page.getByRole('button', { name: 'Ease out' }).click();
  await expect(page.getByTestId('timing-stage')).toHaveText('Save changes');
  await expect(page.getByTestId('timing-save-warning')).toContainText('save again');
});

test('the capability panel reports only what was detected', async ({ page }) => {
  await openPanel(page, 'capability');
  const panel = page.getByTestId('capability-panel');

  // No controller is attached in a headless browser, so nothing may be claimed.
  await expect(panel).toContainText('no controller');
  await expect(panel).toContainText('Effective tier');
  await expect(panel).toContainText('no haptic output on this device', {
    ignoreCase: true,
  });
});

test('the terrain panel switches presets and shows grounding debug', async ({ page }) => {
  await openPanel(page, 'terrain');
  await page.getByTestId('terrain-select').selectOption('stairs');

  const panel = page.getByTestId('terrain-panel');
  await expect(panel).toContainText('Terrain state');
  await expect(panel).toContainText('Ground normal');
  await expect(panel).toContainText('Foot sliding');
});

test('the acquisition panel refuses an unknown licence', async ({ page }) => {
  await openPanel(page, 'acquisition');
  const panel = page.getByTestId('acquisition-panel');
  await expect(panel).toContainText('Unknown is never treated as permission');
});

test('the mobile pad can be toggled on and accepts touch input', async ({ page }) => {
  const toggle = page.getByTestId('toggle-pad');
  if ((await toggle.textContent())?.includes('Show pad')) {
    await toggle.click();
  }
  await expect(page.getByTestId('mobile-pad')).toBeVisible();
  await expect(page.getByTestId('mobile-stick')).toBeVisible();
  await expect(page.getByTestId('pad-Jump')).toBeVisible();
});

test('clean capture mode hides every panel and can be restored', async ({ page }) => {
  await page.getByRole('button', { name: 'Clean capture' }).click();
  await expect(page.getByTestId('hud')).toBeHidden();
  await expect(page.getByTestId('status-bar')).toBeHidden();

  await page.getByRole('button', { name: 'Show UI' }).click();
  await expect(page.getByTestId('hud')).toBeVisible();
});

test('the layout does not scroll horizontally at any viewport', async ({ page }) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  expect(overflow).toBe(false);
});
