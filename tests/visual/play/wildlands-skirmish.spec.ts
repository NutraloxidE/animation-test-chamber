/**
 * Wildlands Skirmish in the browser.
 *
 * Driven through the deterministic play driver rather than by waiting: a match
 * is five real minutes, and a test that slept through one would be a test
 * nobody runs. `advancePlayTicks` steps the same fixed-step runtime the rAF
 * loop steps, so this asserts on the real Scene, the real Scripts and the real
 * renderer at an exact tick.
 */
import { expect, test } from "@playwright/test";

type Snapshot = Record<string, Record<string, Record<string, unknown>>>;

const PLAYER = "skirmish-player";
const DIRECTOR = "match-director";

async function drawnCharacters(page: import("@playwright/test").Page): Promise<number> {
  const models = await page.evaluate(() => window.__ATC_TEST__!.getPlayRenderedModels());
  return models.filter((model) =>
    model.assetPath.includes("quaternius-universal-base/Superhero_Female_FullBody.gltf"),
  ).length;
}

/**
 * Opens the match, waits for the whole cast to be on screen, and only then
 * takes the clock.
 *
 * The order matters: ten skinned characters arrive through Suspense over
 * several frames, and a test that stopped the clock first would be driving a
 * Scene that had not finished appearing.
 */
async function open(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/play/wildlands-skirmish");
  await expect(page.getByTestId("play-canvas")).toBeVisible();
  await expect(page.getByTestId("skirmish-hud")).toBeVisible();
  await expect.poll(() => drawnCharacters(page), { timeout: 40_000 }).toBe(10);
  await page.evaluate(() => window.__ATC_TEST__!.enablePlay());
}

async function snapshot(page: import("@playwright/test").Page): Promise<Snapshot> {
  return page.evaluate(() => window.__ATC_TEST__!.getPlayGameplaySnapshot()) as Promise<Snapshot>;
}

async function advance(page: import("@playwright/test").Page, ticks: number): Promise<void> {
  await page.evaluate((count) => window.__ATC_TEST__!.advancePlayTicks(count), ticks);
  await page.evaluate(() => window.__ATC_TEST__!.flushReact());
}

async function send(
  page: import("@playwright/test").Page,
  target: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await page.evaluate(
    ([id, event, body]) =>
      window.__ATC_TEST__!.sendPlayEvent(id as string, event as string, body as Record<string, never>),
    [target, type, payload] as const,
  );
}

test("the match boots 5 v 5 with the canonical Universal Base character", async ({ page }) => {
  await open(page);
  const states = await snapshot(page);
  const combatants = Object.entries(states).filter(([, components]) => components["combatant"]);
  expect(combatants).toHaveLength(10);
  expect(combatants.filter(([, components]) => components["combatant"]!["team"] === "ally")).toHaveLength(5);
  expect(combatants.filter(([, components]) => components["combatant"]!["team"] === "enemy")).toHaveLength(5);

  const drawn = (await page.evaluate(() => window.__ATC_TEST__!.getPlayRenderedModels())).filter((model) =>
    model.assetPath.includes("quaternius-universal-base/Superhero_Female_FullBody.gltf"),
  );
  /* Nothing is parked at the origin: every fighter is at its authored spawn. */
  for (const model of drawn) expect(Math.hypot(model.position[0], model.position[2])).toBeGreaterThan(1);
});

test("the HUD reports authoritative match state and the day advances", async ({ page }) => {
  await open(page);
  await expect(page.getByTestId("skirmish-score")).toContainText("ALLY");
  await expect(page.getByTestId("skirmish-vitals")).toContainText("120 / 120");
  await advance(page, 900);
  const director = (await snapshot(page))[DIRECTOR]!["director"]!;
  expect(Number(director["matchTicks"])).toBeGreaterThan(800);
  expect(["morning", "day"]).toContain(String(director["phase"]));
});

test("held equipment switches the loadout, the motion context and the held visual", async ({ page }) => {
  await open(page);
  await advance(page, 10);
  const before = await page.evaluate(() => window.__ATC_TEST__!.getPlayCharacterSnapshot("skirmish-player"));
  expect(before?.motionContextKey).toBe("sword");

  await send(page, PLAYER, "set-loadout", { index: 2 });
  await advance(page, 8);
  const after = await page.evaluate(() => window.__ATC_TEST__!.getPlayCharacterSnapshot("skirmish-player"));
  expect(after?.motionContextKey).toBe("magic");
  const state = (await snapshot(page))[PLAYER]!["combatant"]!;
  expect(state["loadoutId"]).toBe("magic");
  await expect(page.getByTestId("skirmish-vitals")).toContainText("Ember Focus");
});

test("armour bought at the quartermaster changes stats and survives a respawn", async ({ page }) => {
  await open(page);
  await advance(page, 10);
  await send(page, DIRECTOR, "debug", { action: "currency", amount: 200 });
  await advance(page, 6);
  const baseline = (await snapshot(page))[PLAYER]!["combatant"]!;

  await send(page, DIRECTOR, "purchase", { itemId: "plated-cuirass" });
  await advance(page, 8);
  const equipped = (await snapshot(page))[PLAYER]!["combatant"]!;
  expect(equipped["chest"]).toBe("plated-cuirass");
  expect(Number(equipped["defense"])).toBe(Number(baseline["defense"]) + 7);
  expect(Number(equipped["maxHp"])).toBe(Number(baseline["maxHp"]) + 22);

  await send(page, PLAYER, "force-ko", {});
  await advance(page, 20);
  await expect(page.getByTestId("skirmish-respawn")).toBeVisible();
  await advance(page, 260);
  const respawned = (await snapshot(page))[PLAYER]!["combatant"]!;
  expect(respawned["alive"]).toBe(true);
  expect(respawned["chest"]).toBe("plated-cuirass");
  expect(Number(respawned["hp"])).toBe(Number(respawned["maxHp"]));
});

test("a level-up pauses the match until exactly one stat is chosen", async ({ page }) => {
  await open(page);
  await advance(page, 10);
  await send(page, DIRECTOR, "debug", { action: "xp", amount: 90 });
  await advance(page, 6);
  await expect(page.getByTestId("skirmish-levelup")).toBeVisible();

  const before = (await snapshot(page))[PLAYER]!["combatant"]!;
  await page.keyboard.press("Digit3");
  await advance(page, 8);
  await expect(page.getByTestId("skirmish-levelup")).toBeHidden();
  const after = (await snapshot(page))[PLAYER]!["combatant"]!;
  expect(Number(after["attack"])).toBe(Number(before["attack"]) + 4);
  const director = (await snapshot(page))[DIRECTOR]!["director"]!;
  expect(Number(director["pendingLevelUps"])).toBe(0);
  expect(Number(director["upAttack"])).toBe(1);
});

test("a match ends, shows a result, and resets into the next day", async ({ page }) => {
  await open(page);
  await advance(page, 10);
  await send(page, DIRECTOR, "debug", { action: "currency", amount: 120 });
  await send(page, DIRECTOR, "debug", { action: "xp", amount: 200 });
  await advance(page, 8);

  await send(page, DIRECTOR, "debug", { action: "end-match", amount: 0 });
  await advance(page, 10);
  await expect(page.getByTestId("skirmish-result")).toBeVisible();
  const ending = (await snapshot(page))[DIRECTOR]!["director"]!;
  const generation = Number(ending["generation"]);

  await advance(page, 700);
  const next = (await snapshot(page))[DIRECTOR]!["director"]!;
  expect(Number(next["generation"])).toBeGreaterThan(generation);
  expect(next["matchState"]).toBe("active");
  expect(Number(next["currency"])).toBe(0);
  expect(Number(next["level"])).toBe(1);
  expect((next["pickups"] as unknown[]).length).toBe(0);
  expect(next["warnings"]).toEqual([]);
  await expect(page.getByTestId("skirmish-score")).toContainText("ALLY 00");
});
