/// <reference types="vite/client" />
import type { SimulationState } from '@atc/replay-runtime';
import type { WorldObservation } from '@atc/world-runtime';
import { useChamber } from './store.ts';
import type { ChamberEngine } from './engine.ts';

let activeEngine: ChamberEngine | null = null;

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
  if (import.meta.env.VITE_ATC_VISUAL_TEST === '1') {
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [] });
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
  };
}
