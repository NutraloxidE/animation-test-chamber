/// <reference types="vite/client" />
import type { SimulationState } from "@atc/replay-runtime";
import type { WorldObservation } from "@atc/world-runtime";
import { useChamber } from "./store.ts";
import type { ChamberEngine } from "./engine.ts";
import type { RuntimeScene } from "@atc/game-object-runtime";
import type { CharacterIntent } from "@atc/character-control-runtime";
import type { GameplayCharacterSnapshot } from "@atc/gameplay-sdk";
import type { JsonObject } from "@atc/schema";
import type { Camera, Scene } from "three";

let activeEngine: ChamberEngine | null = null;
let activePlayRuntime: RuntimeScene | null = null;
let activePlayThreeScene: Scene | null = null;
let activePlayThreeCamera: Camera | null = null;
let playTestDriven = false;

export function registerPlayRuntime(runtime: RuntimeScene): () => void {
  if (!import.meta.env.DEV) return () => undefined;
  activePlayRuntime = runtime;
  playTestDriven = false;
  return () => {
    if (activePlayRuntime === runtime) activePlayRuntime = null;
  };
}

export function isPlayTestDriven(): boolean {
  return playTestDriven;
}

export function registerPlayThreeScene(
  scene: Scene,
  camera: Camera,
): () => void {
  if (!import.meta.env.DEV) return () => undefined;
  activePlayThreeScene = scene;
  activePlayThreeCamera = camera;
  return () => {
    if (activePlayThreeScene === scene) activePlayThreeScene = null;
    if (activePlayThreeCamera === camera) activePlayThreeCamera = null;
  };
}

export interface PlayRenderedModelSnapshot {
  id: string;
  position: [number, number, number];
  assetPath: string;
  scale: number;
  rotationYRad: number;
  animationState: string;
  animationTime: number;
  blendWeight: number;
}

export interface PlayCameraSnapshot {
  position: [number, number, number];
  yaw: number;
}

/** Point browser automation at the engine owned by the currently mounted workspace. */
export function registerTestEngine(engine: ChamberEngine): () => void {
  if (!import.meta.env.DEV) return () => undefined;
  activeEngine = engine;
  return () => {
    if (activeEngine === engine) activeEngine = null;
  };
}

function testEngine(): ChamberEngine {
  return activeEngine ?? useChamber.getState().engine;
}

/**
 * Fixed-tick test driver (PLAN Part VII §27). Lets a Playwright test replace
 * `waitForTimeout` with an exact tick count: `enable()` stops the rAF loop
 * from also advancing the simulation from wall-clock deltas, `advanceTicks`
 * steps it deterministically, and `flushReact` waits for the resulting state
 * to reach the DOM before the test asserts on it.
 *
 * Only ever attached in dev builds — `import.meta.env.DEV` is inlined to
 * `false` in a production build, so this whole module is dead code there and
 * `window.__ATC_TEST__` never exists outside a Playwright-driven dev server.
 */
export interface AtcTestDriver {
  enable(): void;
  advanceTicks(count: number): void;
  flushReact(): Promise<void>;
  getSnapshot(): SimulationState;

  /**
   * World-mode equivalents.
   *
   * The world has its own clock, so a visual test that stepped the focused
   * engine and then asserted on the world would be asserting about a
   * simulation it never advanced.
   */
  enableWorld(): void;
  advanceWorldTicks(count: number): void;
  observeWorld(): WorldObservation;
  enablePlay(): void;
  injectPlayIntent(playerIndex: number, intent: CharacterIntent): void;
  advancePlayTicks(count: number, cameraYawRad?: number): void;
  sendPlayEvent(targetNodeId: string, type: string, payload?: JsonObject): void;
  getPlayGameplaySnapshot(): ReturnType<RuntimeScene["gameplaySnapshot"]>;
  getPlayCharacterSnapshot(
    runtimeNodeId: string,
  ): GameplayCharacterSnapshot | undefined;
  getPlayRenderedModels(): PlayRenderedModelSnapshot[];
  getPlayCameraSnapshot(): PlayCameraSnapshot | undefined;
}

declare global {
  interface Window {
    __ATC_TEST__?: AtcTestDriver;
  }
}

function flushReact(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function installTestDriver(): void {
  if (!import.meta.env.DEV) return;
  if (import.meta.env.VITE_ATC_VISUAL_TEST === "1") {
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [],
    });
  }
  window.__ATC_TEST__ = {
    enable() {
      testEngine().testDriven = true;
    },
    advanceTicks(count) {
      testEngine().advanceTicksForTest(count);
    },
    flushReact,
    getSnapshot() {
      return testEngine().simulationState;
    },
    enableWorld() {
      useChamber.getState().worldEngine.testDriven = true;
    },
    advanceWorldTicks(count) {
      const engine = useChamber.getState().worldEngine;
      for (let i = 0; i < count; i += 1) engine.stepOnce();
    },
    observeWorld() {
      return useChamber.getState().worldEngine.observe();
    },
    enablePlay() {
      playTestDriven = true;
    },
    injectPlayIntent(playerIndex, intent) {
      activePlayRuntime?.injectHumanIntent(playerIndex, intent);
    },
    advancePlayTicks(count, cameraYawRad = 0) {
      for (let index = 0; index < count; index += 1)
        activePlayRuntime?.step({ cameraYawRad });
    },
    sendPlayEvent(targetNodeId, type, payload = {}) {
      activePlayRuntime?.emit(targetNodeId, { type, payload });
    },
    getPlayGameplaySnapshot() {
      return activePlayRuntime?.gameplaySnapshot() ?? {};
    },
    getPlayCharacterSnapshot(runtimeNodeId) {
      return activePlayRuntime
        ?.getRuntimeNode(runtimeNodeId)
        ?.character?.gameplaySnapshot();
    },
    getPlayRenderedModels() {
      if (!activePlayThreeScene) return [];
      activePlayThreeScene.updateMatrixWorld(true);
      const result: PlayRenderedModelSnapshot[] = [];
      activePlayThreeScene.traverse((object) => {
        if (object.userData.atcRenderedModel !== true) return;
        const matrix = object.matrixWorld.elements;
        result.push({
          id: String(object.userData.atcGameObjectId),
          position: [matrix[12]!, matrix[13]!, matrix[14]!],
          assetPath: String(object.userData.atcModelAssetPath),
          scale: Number(object.userData.atcModelScale),
          rotationYRad: Number(object.userData.atcModelRotationYRad),
          animationState: String(object.userData.atcAnimationState),
          animationTime: Number(object.userData.atcAnimationTime),
          blendWeight: Number(object.userData.atcBlendWeight),
        });
      });
      return result;
    },
    getPlayCameraSnapshot() {
      if (!activePlayThreeCamera) return undefined;
      const { x, y, z, w } = activePlayThreeCamera.quaternion;
      return {
        position: activePlayThreeCamera.position.toArray(),
        yaw: Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z)),
      };
    },
  };
}
