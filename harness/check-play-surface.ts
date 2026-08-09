import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectDefinition } from "@atc/schema";
import {
  resolveGameObjectPrefab,
  resolvedComponents,
} from "@atc/prefab-runtime";
import { loadPrefabRegistry } from "./prefabs.ts";

const root = resolve(import.meta.dirname, "..");
const router = readFileSync(
  resolve(root, "apps/web/src/app/router.tsx"),
  "utf8",
);
const play = readFileSync(
  resolve(root, "apps/web/src/game-runtime/PlayScenePage.tsx"),
  "utf8",
);
const overlay = readFileSync(
  resolve(root, "apps/web/src/game-ui/GameOverlay.tsx"),
  "utf8",
);
const renderer = readFileSync(
  resolve(root, "apps/web/src/game-objects/GameObjectRenderer.tsx"),
  "utf8",
);
const animated = readFileSync(
  resolve(root, "apps/web/src/game-objects/AnimatedRepositoryModel.tsx"),
  "utf8",
);
const runtime = readFileSync(
  resolve(root, "packages/game-object-runtime/src/runtime.ts"),
  "utf8",
);
const project = JSON.parse(
  readFileSync(resolve(root, "projects/demo-character/project.json"), "utf8"),
) as ProjectDefinition;
const fail = (message: string): never => {
  throw new Error(`play-surface: ${message}`);
};

if (!router.includes("path={ROUTES.root} element={<PlayScenePage />}"))
  fail("/ must mount PlayScenePage directly");
if (!router.includes("path={ROUTES.playScene} element={<PlayScenePage />}"))
  fail("/play/:sceneId must mount PlayScenePage");
for (const forbidden of [
  "EditSession",
  "AuthoringSession",
  "SceneEditorPage",
  "PrefabEditorPage",
  "<OrbitControls",
])
  if (play.includes(forbidden))
    fail(`play host contains forbidden editor surface: ${forbidden}`);
for (const required of [
  "canonicalProject",
  "BrowserInputSampler",
  "injectHumanIntent",
  "cameraYawRad",
  "activeCameraGameObjectId",
  "AuthoredCamera",
  "GameObjectRenderer",
  "GameOverlay",
])
  if (!play.includes(required)) fail(`play host lacks ${required}`);
for (const forbidden of [
  "preparePlayScene",
  "latestVersion(",
  "two-humanoids-shared-animation",
  "gameplay-navigator",
  "quaternius-universal-base",
])
  if (play.includes(forbidden))
    fail(
      `play host contains Scene-specific or floating composition: ${forbidden}`,
    );
if (animated.includes("mixer.update(delta)"))
  fail(
    "animated repository renderer advances animation from render-wall-clock time",
  );
for (const field of [
  "previousStateId",
  "previousNormalizedTime",
  "blendWeight",
]) {
  if (!runtime.includes(field) || !animated.includes(field))
    fail(`deterministic animation render state lacks ${field}`);
}
for (const field of ["binding.scale", "binding.rotationYRad"])
  if (!renderer.includes(field))
    fail(`renderer drops canonical model ${field}`);

const scene = project.scenes.find(
  (candidate) => candidate.id === "two-humanoids-shared-animation",
);
if (!scene) throw new Error("play-surface: Two Humanoids Scene is missing");
if (!scene.gameObjects)
  throw new Error("play-surface: Two Humanoids has no canonical GameObjects");
const gameObjects = scene.gameObjects;
const characters = gameObjects.filter(
  (object) =>
    object.id === "controlled-humanoid" || object.id === "scripted-humanoid",
);
if (
  characters.length !== 2 ||
  characters.some((object) => object.prefab.assetId !== "gameplay-quaternius")
)
  fail("Two Humanoids does not reference gameplay-quaternius exactly");
const registry = loadPrefabRegistry();
for (const object of characters) {
  if (registry.checkReference(object.prefab).length > 0)
    fail(`${object.id} references a missing or hash-invalid playable Prefab`);
}
const playable = resolveGameObjectPrefab(registry, characters[0]!.prefab);
const components = resolvedComponents(playable.prefab.root);
for (const type of [
  "model-renderer",
  "animator",
  "character-motor",
  "capsule-collider",
])
  if (!components.some((component) => component.componentType === type))
    fail(`gameplay-quaternius lacks ${type}`);
for (const id of ["health", "stamina", "air-dash"])
  if (
    !components.some(
      (component) =>
        component.componentType === "script" && component.componentId === id,
    )
  )
    fail(`gameplay-quaternius lacks ${id} script`);
const camera = gameObjects.find(
  (object) => object.id === scene.activeCameraGameObjectId,
);
if (
  !camera ||
  camera.relations.cameraTargetGameObjectId !== "controlled-humanoid"
)
  fail("active Camera target relation is not canonical");
if (!overlay.includes("game-overlay"))
  fail("GameOverlay does not own the game overlay surface");
console.log("PLAY SURFACE: PASS");
