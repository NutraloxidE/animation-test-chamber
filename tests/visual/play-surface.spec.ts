import { expect, test } from "@playwright/test";

type RenderedObjectEvidence = {
  id: string;
  position: { x: number; y: number; z: number };
  model?: {
    kind: string;
    assetPath?: string;
    scale?: number;
    rotationYRad?: number;
  };
  animationState?: string;
  animationTime?: number;
  blendWeight?: number;
};

async function renderedObjects(
  page: import("@playwright/test").Page,
): Promise<RenderedObjectEvidence[]> {
  const raw = await page
    .getByTestId("play-render-evidence")
    .getAttribute("data-rendered-objects");
  return raw ? (JSON.parse(raw) as RenderedObjectEvidence[]) : [];
}

test("root play surface accepts human input and runs Air Dash through Gameplay Script", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("play-canvas")).toBeVisible();
  await expect(page.getByTestId("game-overlay")).toBeVisible();
  await expect(page.getByTestId("scene-editor")).toHaveCount(0);
  await expect
    .poll(async () => renderedObjects(page).then((objects) => objects.length))
    .toBeGreaterThan(0);
  const renderedBefore = (await renderedObjects(page)).find(
    (object) => object.id === "controlled-humanoid",
  )!;
  expect(renderedBefore.model).toEqual({
    kind: "repository-model",
    assetPath:
      "/assets/characters/quaternius-universal-base/Superhero_Female_FullBody.gltf",
    scale: 1,
    rotationYRad: 0,
  });
  const cameraBefore = JSON.parse(
    (await page
      .getByTestId("play-render-evidence")
      .getAttribute("data-camera-position"))!,
  ) as number[];

  const before = await page.evaluate(() =>
    window.__ATC_TEST__!.getPlayCharacterSnapshot("controlled-humanoid"),
  );
  await page.keyboard.down("KeyW");
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.__ATC_TEST__!.getPlayCharacterSnapshot(
              "controlled-humanoid",
            ),
          )
        )?.worldTransform.position.z,
    )
    .not.toBe(before?.worldTransform.position.z);
  await expect
    .poll(
      async () =>
        (await renderedObjects(page)).find(
          (object) => object.id === "controlled-humanoid",
        )?.position.z,
    )
    .not.toBe(renderedBefore.position.z);
  await expect
    .poll(
      async () =>
        (await renderedObjects(page)).find(
          (object) => object.id === "controlled-humanoid",
        )?.animationState,
    )
    .toMatch(/walk|run/);
  await expect
    .poll(
      async () =>
        JSON.parse(
          (await page
            .getByTestId("play-render-evidence")
            .getAttribute("data-camera-position"))!,
        ) as number[],
    )
    .not.toEqual(cameraBefore);
  await page.keyboard.up("KeyW");

  const yawBefore = Number(
    await page
      .getByTestId("play-render-evidence")
      .getAttribute("data-camera-yaw"),
  );
  await page.mouse.move(200, 200);
  await page.mouse.move(320, 200);
  await expect
    .poll(async () =>
      Number(
        await page
          .getByTestId("play-render-evidence")
          .getAttribute("data-camera-yaw"),
      ),
    )
    .not.toBeCloseTo(yawBefore);

  await page.evaluate(() => {
    window.__ATC_TEST__!.enablePlay();
    window.__ATC_TEST__!.sendPlayEvent("controlled-humanoid", "dash");
    window.__ATC_TEST__!.advancePlayTicks(2);
  });
  const queued = await page.evaluate(() =>
    window.__ATC_TEST__!.getPlayCharacterSnapshot("controlled-humanoid"),
  );
  expect(
    queued?.activeMotionOverrides.some((entry) => entry.key === "dash"),
  ).toBe(true);
  expect(queued?.gameplayParameters["gameplay.dashing"]).toBe(true);
  await page.evaluate(() => window.__ATC_TEST__!.advancePlayTicks(20));
  const expired = await page.evaluate(() =>
    window.__ATC_TEST__!.getPlayCharacterSnapshot("controlled-humanoid"),
  );
  expect(expired?.activeMotionOverrides).toEqual([]);
  expect(expired?.gameplayParameters["gameplay.dashing"]).toBeUndefined();
});

test("explicit unknown play route refuses without fallback", async ({
  page,
}) => {
  await page.goto("/play/no-such-scene");
  await expect(page.getByTestId("play-surface")).toContainText("no-such-scene");
  await expect(page.getByTestId("play-canvas")).toHaveCount(0);
});
