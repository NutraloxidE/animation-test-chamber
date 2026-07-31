/// <reference types="vite/client" />
import type { SimulationState } from '@atc/replay-runtime';
import { useChamber } from './store.ts';

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
  window.__ATC_TEST__ = {
    enable() {
      useChamber.getState().engine.testDriven = true;
    },
    advanceTicks(count) {
      useChamber.getState().engine.advanceTicksForTest(count);
    },
    flushReact,
    getSnapshot() {
      return useChamber.getState().engine.simulationState;
    },
  };
}
