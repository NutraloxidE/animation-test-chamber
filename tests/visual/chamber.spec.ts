import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PROJECT_PATH, resetRepositoryProject } from './repository.ts';

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

/**
 * The Hierarchy dock (weapon/equipment; the Character is the route now) only
 * defaults open above
 * the 900px breakpoint — below it, it would otherwise overlay and block the
 * rest of the narrow layout (PLAN Part VI, the same overlay-by-default bug
 * fixed for the bottom sheet).
 */
async function openHierarchy(page: Page): Promise<void> {
  if (!(await page.getByTestId('weapon-mode-select').isVisible())) {
    await page.getByTestId('toggle-hierarchy').click();
  }
}

/**
 * On a narrow viewport the Hierarchy dock is a full-height overlay (unlike
 * desktop, where it is a reserved column) — closing it once done frees the
 * area other overlays (the bottom sheet, its buttons) also need.
 */
async function closeHierarchy(page: Page): Promise<void> {
  if (await page.getByTestId('weapon-mode-select').isVisible()) {
    await page.getByTestId('toggle-hierarchy').click();
  }
}

/**
 * Fixed-tick waiting (PLAN Part VII §27): pumps the simulation forward in
 * exact steps instead of waiting on the wall clock, so how fast this
 * particular machine happens to be rendering frames can never make a test
 * flake. Requires `window.__ATC_TEST__.enable()` to already have been called.
 */
async function advanceTicksUntil(
  page: Page,
  isDone: () => Promise<boolean>,
  maxTicks: number,
  step = 10,
): Promise<void> {
  for (let advanced = 0; advanced < maxTicks; advanced += step) {
    // One round trip per step: advancing and flushing separately doubles the
    // Playwright <-> browser IPC overhead for no benefit, and that overhead
    // (not simulation cost) is what dominates a many-iteration wait.
    await page.evaluate(async (n) => {
      window.__ATC_TEST__!.advanceTicks(n);
      await window.__ATC_TEST__!.flushReact();
    }, step);
    if (await isDone()) return;
  }
}

test.beforeEach(async ({ page }) => {
  // `/` is the Prefab inventory now; the authoring workspace opens from a
  // Prefab's Animator, which is where the chamber lives.
  await page.goto('/edit/prefab/navigator?component=animator');
  await expect(page.getByTestId('hud')).toBeVisible();
});

test('boots with the demo project and a running simulation', async ({ page }) => {
  await expect(page.getByTestId('viewport-canvas').locator('canvas')).toBeVisible();

  // The tick counter proves the fixed-step loop is actually advancing.
  const hud = page.getByTestId('hud');
  const firstTick = await hud.textContent();
  await page.waitForTimeout(600);
  expect(await hud.textContent()).not.toBe(firstTick);
});

test('the character responds to keyboard input', async ({ page }) => {
  const hud = page.getByTestId('hud');
  await expect(hud).toContainText('idle');

  // No canvas click: the input sampler listens on `window`, not the canvas,
  // so keyboard input works with no explicit focus step at all — which also
  // sidesteps whatever happens to overlay the canvas at a given viewport
  // size (the mobile pad, an open panel, the viewport-controls panel).
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

test('an imported Character plays its canonical takes, and its grip is editable', async ({ page }) => {
  /*
   * Switching Character is navigation now. It used to be a preset selector in
   * the Hierarchy, which is exactly the hidden second selector the work package
   * removed: it changed the model without changing the Character being edited.
   */
  await page.goto('/edit/prefab/quaternius-universal-base?component=animator');
  await expect(page.getByTestId('prefab-target-id')).toContainText('quaternius-universal-base');
  await expect(page.getByTestId('status-bar')).toContainText('Universal Base Superhero');
  await openHierarchy(page);
  const swordAsset = page.waitForResponse((response) =>
    response.url().endsWith('/assets/animations/quaternius-universal-2/UAL2_Standard_RM.glb'),
  );
  await page.getByTestId('weapon-mode-select').selectOption('sword');
  expect((await swordAsset).ok()).toBe(true);
  await expect(page.getByTestId('status-bar')).toContainText('Sword');
  await closeHierarchy(page);
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
  // Weapon and equipment moved into the Hierarchy dock (and the Character is
  // the route); only
  // viewport-controls' own body (e.g. the grip editor) collapses with it.
  await expect(page.getByTestId('grip-editor-select')).toBeHidden();
});

test('jump and attack drive the two layers independently', async ({ page }) => {
  const hud = page.getByTestId('hud');
  // No canvas click: the input sampler listens on `window`, not the canvas,
  // so keyboard input needs no explicit focus step — see the keyboard-input
  // test above for why.
  // Fixed-tick driver (PLAN Part VII §27): the jump's air time is physics-
  // derived, not a fixed duration, so waiting on it with a wall-clock timeout
  // either guesses too short (flaky) or too long (slow). Ticking forward
  // until the HUD itself reports landed sidesteps the guess entirely.
  await page.evaluate(() => window.__ATC_TEST__!.enable());

  await page.keyboard.press('Space');
  await advanceTicksUntil(
    page,
    async () => /jump|fall|land/.test((await hud.textContent()) ?? ''),
    20,
    2,
  );
  await expect(hud).toContainText(/jump|fall|land/);

  await advanceTicksUntil(page, async () => (await hud.textContent())?.includes('idle') ?? false, 240);
  await expect(hud).toContainText('idle');

  await page.keyboard.press('KeyJ');
  await advanceTicksUntil(page, async () => (await hud.textContent())?.includes('attack-01') ?? false, 40);
  await expect(hud).toContainText('attack-01');
});

test('sword attacks play their matching recovery clips', async ({ page }) => {
  // Deterministic now, not slow — just several dozen tick-and-check round
  // trips to the browser, which the default 45s budget can be tight on.
  test.setTimeout(90_000);
  const hud = page.getByTestId('hud');
  await page.goto('/edit/prefab/quaternius-universal-base?component=animator');
  await expect(page.getByTestId('prefab-target-id')).toContainText('quaternius-universal-base');
  await openHierarchy(page);
  await page.getByTestId('weapon-mode-select').selectOption('sword');
  await closeHierarchy(page);
  // Fixed-tick driver (PLAN Part VII §27): both fixtures below are ≤160 ticks
  // of scripted replay, so ticking forward deterministically replaces waiting
  // on however fast this machine renders frames.
  await page.evaluate(() => window.__ATC_TEST__!.enable());

  const includesText = (locator: ReturnType<Page['getByTestId']>, text: string) => async () =>
    (await locator.textContent())?.includes(text) ?? false;

  await openPanel(page, 'replay');
  const replaySelect = page.getByTestId('replay-panel').locator('select').first();
  await replaySelect.selectOption('run-to-attack-forward');
  await page.getByTestId('play-replay').click();
  await advanceTicksUntil(page, includesText(hud, 'attack-01-recovery'), 200);
  await expect(hud).toContainText('attack-01-recovery');
  await advanceTicksUntil(page, includesText(hud, 'action-none'), 100);
  await expect(hud).toContainText('action-none');

  await page.getByTestId('replay-panel').locator('select').first().selectOption('attack-01-to-attack-02');
  await page.getByTestId('play-replay').click();
  await advanceTicksUntil(page, includesText(hud, 'attack-02'), 100);
  await expect(hud).toContainText('attack-02');
  await advanceTicksUntil(page, includesText(hud, 'attack-02-recovery'), 100);
  await expect(hud).toContainText('attack-02-recovery');
  await advanceTicksUntil(page, includesText(hud, 'action-none'), 150);
  await expect(hud).toContainText('action-none');

  await openPanel(page, 'inspector');
  await page.getByTestId('blend-list').click();
  await expect(page.getByTestId('blend-attack-01-to-recovery')).toBeVisible();
  await expect(page.getByTestId('blend-attack-01-recovery-to-none')).toBeVisible();
  await expect(page.getByTestId('blend-attack-02-to-recovery')).toBeVisible();
  await expect(page.getByTestId('blend-attack-02-recovery-to-none')).toBeVisible();

  // Filtering and sorting the blend list: comparing blends against each other is
  // the point of the list, and it is too long to do that by eye unsorted.
  await page.getByTestId('blend-filter').fill('dodge');
  await expect(page.getByTestId('blend-attack-01-to-dodge')).toBeVisible();
  await expect(page.getByTestId('blend-attack-01-to-recovery')).toHaveCount(0);
  await expect(page.getByTestId('blend-list').locator('summary')).toContainText('of');

  await page.getByTestId('blend-filter').fill('');
  await page.getByTestId('blend-sort').selectOption('duration');
  // Sorting is per layer section, so compare inside one of them.
  const durations = await page
    .getByTestId('blend-list')
    .locator('section')
    .first()
    .locator('.blend-row output')
    .allInnerTexts();
  const values = durations.map((text) => Number.parseFloat(text));
  expect(values.length).toBeGreaterThan(1);
  expect([...values].sort((a, b) => b - a)).toEqual(values);
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
  await page.getByTestId('clip-select').selectOption('unarmed-attack-01');
  await expect(page.getByTestId('field-/clips/unarmed-attack-01/rootDisplacement/z')).toContainText(
    'Forward displacement adjustment',
  );
  // Canonical value is 0.5, a deliberate human tuning (DECISIONS/0008).
  await expect(page.getByTestId('field-/clips/unarmed-attack-01/rootDisplacement/z')).toContainText('+0.50 m');
  await expect(page.getByTestId('field-/clips/unarmed-attack-01/inputAcceptanceStartNormalized')).toContainText('62%');
  await page.getByTestId('action-input-list').click();
  await expect(page.getByTestId('action-input-unarmed-attack-01')).toBeVisible();
  await expect(page.getByTestId('action-input-unarmed-attack-01-recovery')).toContainText('0%');

  // Fixed-tick driver (PLAN Part VII §27): the replay's progress only moves
  // when something advances it, and how much real time that needs depends
  // on however fast this machine happens to render — ticking forward
  // deterministically replaces waiting on however fast the replay plays.
  await page.evaluate(() => window.__ATC_TEST__!.enable());
  await openPanel(page, 'replay');
  await page.getByTestId('replay-panel').locator('select').first().selectOption('run-to-attack-forward');
  await page.getByTestId('play-replay').click();
  await page.evaluate(async () => {
    window.__ATC_TEST__!.advanceTicks(75);
    await window.__ATC_TEST__!.flushReact();
  });
  await openPanel(page, 'inspector');
  await page.getByTestId('clip-select').selectOption('unarmed-attack-01');
  await page.getByTestId('action-input-list').click();
  const liveAttack = page.getByTestId('action-input-unarmed-attack-01').locator('..');
  await expect(liveAttack).toHaveClass(/blend-row--live/);
  await expect(liveAttack).toContainText('PLAYING');
  await expect(page.getByTestId('selected-action-playback')).toContainText('PLAYING');
  expect(Number(await liveAttack.getAttribute('data-progress'))).toBeGreaterThan(0);
  await page.getByTestId('clip-select').selectOption('dodge');

  const distance = page.getByTestId('field-/clips/dodge/rootDisplacement/z');
  await expect(distance).toBeVisible();
  await expect(distance).toContainText('10.0 m');
  await expect(page.getByTestId('field-/clips/dodge/recoveryTransitionStartNormalized')).toContainText('0.620');
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
  /*
   * This test performs a real commit, and the API writes the result back to the
   * canonical file — so the assertion has to read the checkout the *server* is
   * writing to, not the one this spec file happens to sit in. Those are
   * different directories under `pnpm harness:visual`.
   *
   * Snapshot and restore anyway: within one run the tests share a checkout, and
   * an extra revision left behind changes what the next one opens against.
   */
  let original: string;

  /*
   * Each committing test starts from the seed. Both tests here write, and the
   * second one opens a page that seeds from the pristine source project — so
   * without this it declares a baseline the first test already replaced and is
   * refused as a conflict.
   */
  test.beforeEach(() => {
    resetRepositoryProject();
  });

  test.beforeAll(() => {
    original = readFileSync(PROJECT_PATH, 'utf8');
  });

  test.afterAll(() => {
    writeFileSync(PROJECT_PATH, original, 'utf8');
  });

  test('the full stage, validate and commit loop works with the fake Git adapter', async ({ page }) => {
    // A project-owned value: terrain belongs to the project file, not to an
    // animation asset, so it commits straight through.
    await openPanel(page, 'terrain');
    await page
      .getByTestId('field-/terrain/groundSnapStrength')
      .locator('input[type=range]')
      .fill('0.42');

    await openPanel(page, 'diff');
    await page.getByTestId('stage-all').click();

    const commit = page.getByTestId('commit-button');
    await expect(commit).toBeEnabled();
    await commit.click();

    await expect(page.getByTestId('status-bar')).toContainText(/Committed [0-9a-f]{8} to chamber\//, {
      timeout: 15_000,
    });

    const saved = JSON.parse(readFileSync(PROJECT_PATH, 'utf8')) as {
      terrain: { groundSnapStrength: number };
    };
    expect(saved.terrain.groundSnapStrength).toBe(0.42);
  });

  /**
   * An animation value cannot be committed into project.json any more: it
   * belongs to an asset, and which asset is a decision only a human can make.
   * The commit stops and asks rather than picking one (PLAN 12.5, 28).
   */
  test('an animation edit stops the commit and asks where it should live', async ({ page }) => {
    await openPanel(page, 'inspector');
    await page.getByTestId('clip-select').selectOption('dodge');
    await page
      .getByTestId('field-/clips/dodge/rootDisplacement/z')
      .locator('input[type=range]')
      .fill('6.2');

    await openPanel(page, 'diff');
    await page.getByTestId('stage-all').click();
    await page.getByTestId('commit-button').click();

    const dialog = page.getByTestId('save-destination-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('status-bar')).toContainText('belong to an animation asset');
    await expect(page.getByTestId('save-destination-changes')).toContainText('/clips/dodge');

    // A clip-only edit: no graph section, only the clip section.
    await expect(page.getByTestId('save-destination-graph-section')).toHaveCount(0);
    await expect(page.getByTestId('save-destination-clip-section')).toBeVisible();

    // Nothing is preselected, so nothing can be saved until a human chooses.
    await expect(page.getByTestId('save-destination-submit')).toBeDisabled();

    await page.getByTestId('save-destination-clip-character-override').locator('input').check();
    await expect(page.getByTestId('save-destination-submit')).toBeEnabled();
    await page.getByTestId('save-destination-submit').click();

    await expect(page.getByTestId('status-bar')).toContainText(/Saved\. Report:/, {
      timeout: 15_000,
    });

    // The value landed on the character, not in the shared clip asset.
    const saved = JSON.parse(readFileSync(PROJECT_PATH, 'utf8')) as {
      characters: {
        animation: { instanceOverrides: { path: string; value: unknown }[] };
      }[];
    };
    const override = saved.characters[0]!.animation.instanceOverrides.find((entry) =>
      entry.path.includes('/clips/dodge/rootDisplacement/z'),
    );
    expect(override?.value).toBe(6.2);
  });
});

test.describe('static character drafts', () => {

  /**
   * A character-override save never publishes an asset, so it is the one
   * save the chamber must complete with no API server at all (PLAN Part V
   * §24) — exactly the shape a static host is. Blocking /api/health before
   * the app's own startup probe runs makes `backendAvailable()` resolve
   * false for the rest of the page's life, the same as a real static
   * deployment.
   */
  test('an offline character-override save persists as a browser-only draft and survives reload', async ({
    page,
    context,
  }) => {
    await context.route('**/api/health', (route) => route.abort());
    // `/` is the Prefab inventory now; the authoring workspace opens from a
  // Prefab's Animator, which is where the chamber lives.
  await page.goto('/edit/prefab/navigator?component=animator');
    await expect(page.getByTestId('hud')).toBeVisible();

    await openPanel(page, 'inspector');
    await page.getByTestId('clip-select').selectOption('dodge');
    await page
      .getByTestId('field-/clips/dodge/rootDisplacement/z')
      .locator('input[type=range]')
      .fill('6.2');

    await openPanel(page, 'diff');
    await page.getByTestId('stage-all').click();
    await page.getByTestId('commit-button').click();

    const dialog = page.getByTestId('save-destination-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('save-destination-clip-character-override').locator('input').check();
    await page.getByTestId('save-destination-submit').click();

    await expect(page.getByTestId('status-bar')).toContainText(
      'Saved as a browser-only character draft. No repository files were changed.',
    );

    // No repository file was touched — this is the whole point.
    const untouched = JSON.parse(readFileSync(PROJECT_PATH, 'utf8')) as {
      characters: { animation: { instanceOverrides: unknown[] } }[];
    };
    expect(
      untouched.characters.some((character) =>
        character.animation.instanceOverrides.some(
          (entry) => JSON.stringify(entry).includes('dodge') && JSON.stringify(entry).includes('6.2'),
        ),
      ),
    ).toBe(false);

    // Survives a reload: still offline, still applied, from localStorage.
    await page.reload();
    await expect(page.getByTestId('hud')).toBeVisible();
    await openPanel(page, 'inspector');
    await page.getByTestId('clip-select').selectOption('dodge');
    await expect(page.getByTestId('field-/clips/dodge/rootDisplacement/z')).toContainText('6.2 m');
  });

  /**
   * A draft made against a repository revision that has since moved on must
   * never be silently reapplied (PLAN Part V §24) — only ever offered as
   * something to discard.
   */
  test('a stale-revision character draft is not applied and can be discarded', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'atc:character-animation-draft:demo-character:rev-not-current:demo-humanoid',
        JSON.stringify({
          revisionId: 'rev-not-current',
          characterId: 'demo-humanoid',
          instanceOverrides: [{ path: '/clips/dodge/rootDisplacement/z', op: 'set', value: 9.9 }],
        }),
      );
    });
    // `/` is the Prefab inventory now; the authoring workspace opens from a
  // Prefab's Animator, which is where the chamber lives.
  await page.goto('/edit/prefab/navigator?component=animator');
    await expect(page.getByTestId('hud')).toBeVisible();

    const banner = page.getByTestId('stale-character-draft-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('demo-humanoid');

    // Not applied: the field shows the repository value, not the stale draft's.
    await openPanel(page, 'inspector');
    await page.getByTestId('clip-select').selectOption('dodge');
    await expect(page.getByTestId('field-/clips/dodge/rootDisplacement/z')).not.toContainText('9.9 m');

    await page.getByTestId('stale-character-draft-discard-demo-humanoid').click();
    await expect(banner).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem(
          'atc:character-animation-draft:demo-character:rev-not-current:demo-humanoid',
        ),
      ),
    ).toBeNull();
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
  // No canvas click here: the input sampler listens on `window`, not the
  // canvas, and on a narrow viewport the open graph panel visually covers
  // the canvas — a forced click would actually land on the panel's own
  // content underneath instead, which is not what focusing input is for.
  // Fixed-tick driver (PLAN Part VII §27): the combo window opens at 62% of
  // unarmed-attack-01's 45-tick duration. Advancing exact ticks instead of
  // waiting on the wall clock means the second press always lands inside
  // that window, on every machine, instead of racing it.
  await page.evaluate(() => window.__ATC_TEST__!.enable());
  await page.keyboard.press('KeyJ');
  await page.evaluate(() => window.__ATC_TEST__!.advanceTicks(31));
  await page.keyboard.press('KeyJ');
  await page.evaluate(() => window.__ATC_TEST__!.advanceTicks(2));
  await page.evaluate(() => window.__ATC_TEST__!.flushReact());

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
