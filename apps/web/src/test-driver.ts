/// <reference types="vite/client" />
import type { SimulationState } from '@atc/replay-runtime';
import type { WorldObservation } from '@atc/world-runtime';
import { useChamber } from './store.ts';
import { previewNormalizedTime } from './world/world-engine.ts';
import type { AnimationTargetMode } from './animation/target/animation-target.ts';
import type { ClipPreviewSource } from './animation/clip-preview/clip-preview-state.ts';
import type { SandboxObservation } from './animation/state-sandbox/AnimationSandboxEngine.ts';

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

  /**
   * Animation hooks.
   *
   * Deterministic by construction: `stepClipPreview` advances clip seconds and
   * `stepSandbox` advances whole fixed ticks, so a test never has to sleep and
   * hope. A wall-clock wait asserting that an animation progressed is a test
   * that passes on a fast machine and fails on a loaded one, which is worse
   * than no test at all.
   */
  animation: {
    setTargetMode(mode: AnimationTargetMode): void;
    setClipPreview(source: ClipPreviewSource | null): void;
    /** Advances the clip transport by seconds, without touching the world. */
    stepClipPreview(seconds: number): void;
    readClipPreview(): {
      timeSec: number;
      durationSec: number;
      normalizedTime: number;
      playing: boolean;
    } | null;
    createSandbox(bootstrap: {
      layer: 'locomotion' | 'action';
      stateId: string | null;
      normalizedTime?: number;
    }): void;
    stepSandbox(ticks: number): void;
    readSandboxObservation(): SandboxObservation | null;
    clearAnimation(): void;
  };
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

    animation: {
      setTargetMode(mode) {
        useChamber.getState().setAnimationTargetMode(mode);
      },
      setClipPreview(source) {
        const state = useChamber.getState();
        state.setAnimationWorkspaceMode('clip-preview');
        state.setClipPreviewSource(source);
      },
      stepClipPreview(seconds) {
        // Straight at the engine's transport, not through the world clock: a
        // clip preview is not a simulation and advancing it must not require
        // advancing one.
        useChamber.getState().worldEngine.advancePreview(seconds);
      },
      readClipPreview() {
        const preview = useChamber.getState().worldEngine.previewOverride;
        if (!preview) return null;
        return {
          timeSec: preview.timeSec,
          durationSec: preview.durationSec,
          normalizedTime: previewNormalizedTime(preview),
          playing: preview.playing,
        };
      },
      createSandbox(bootstrap) {
        const state = useChamber.getState();
        state.setAnimationWorkspaceMode('state-sandbox');
        if (bootstrap.normalizedTime !== undefined) {
          state.setSandboxNormalizedTime(bootstrap.normalizedTime);
        }
        state.setSandboxBootstrap(bootstrap.layer, bootstrap.stateId);
      },
      stepSandbox(ticks) {
        useChamber.getState().stepSandbox(ticks);
      },
      readSandboxObservation() {
        return useChamber.getState().sandboxEngine?.observation() ?? null;
      },
      clearAnimation() {
        const state = useChamber.getState();
        state.clearClipPreview();
        state.disposeSandbox();
      },
    },
  };
}
