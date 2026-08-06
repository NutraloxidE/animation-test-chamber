/**
 * What the animation panels observe of the running preview.
 *
 * Four members, because that is genuinely all the fine-tuning panels read from
 * the engine: a snapshot, the live graph layers, the last tick record, and a
 * subscription to know when those changed. Everything else `ChamberEngine`
 * exposes — stepping, recording, replay, terrain, camera — belongs to the
 * viewport and the Replay panel, not here.
 *
 * Naming that small surface as a port rather than passing `ChamberEngine`
 * around does two things. It lets a subject that cannot run a simulation still
 * render its panels against an idle preview instead of crashing on
 * `engine.snapshot()`, and it means the Phase G subject-native engine can
 * replace the idle implementation without a single panel changing, because
 * `ChamberEngine` already satisfies this shape structurally.
 */
import type { LayerId, LayerRuntimeState } from '@atc/animation-runtime';
import type { TickRecord } from '@atc/replay-runtime';
import type { EngineSnapshot } from '../engine.ts';

export interface AnimationLivePreview {
  /** Latest tick record, or null when nothing has advanced. */
  readonly lastRecord: TickRecord | null;
  /** Live per-layer state, for state highlighting and blend readouts. */
  readonly graphLayers: Record<LayerId, LayerRuntimeState>;
  snapshot(): EngineSnapshot;
  /** Returns its own unsubscribe, so a panel's effect can clean up. */
  subscribe(listener: () => void): () => void;
}

/**
 * Driving the preview, as opposed to reading it.
 *
 * Split from `AnimationLivePreview` because the two have different audiences:
 * every panel reads, and only the workspace shell and the viewport drive. A
 * panel that could pause the simulation is a panel that can surprise every
 * other panel.
 *
 * `ChamberEngine` satisfies this structurally, which is the point — the shell
 * drives the real engine today and the viewport takes the same handle later,
 * with no adapter in between.
 */
export interface AnimationPreviewControls {
  /** Advances by wall-clock seconds; the fixed-step accumulator does the rest. */
  advance(deltaSec: number): void;
  setPaused(paused: boolean): void;
  readonly isPaused: boolean;
  frameStep(): void;
  reset(): void;
  setTimeScale(scale: number): void;
}

/**
 * Why this subject has no running preview.
 *
 * Carried on the idle preview so the workspace can say which requirement is
 * missing rather than rendering a dead viewport with no explanation.
 */
export interface IdleLivePreviewReason {
  reason: string;
  missing?: 'model' | 'capsule' | 'equipmentSockets' | 'engine';
}

const IDLE_SNAPSHOT: EngineSnapshot = {
  tick: 0,
  position: { x: 0, y: 0, z: 0 },
  yawRad: 0,
  grounded: false,
  terrainState: '',
  locomotionState: '',
  actionState: '',
  locomotionNormalizedTime: 0,
  actionNormalizedTime: 0,
  blendWeight: 0,
  stateMachine: {},
  speed: 0,
  mode: 'live',
  recording: false,
  replayProgress: 0,
};

export interface IdleAnimationLivePreview extends AnimationLivePreview {
  readonly idle: true;
  readonly idleReason: IdleLivePreviewReason;
}

/**
 * A preview that never advances.
 *
 * Every reader gets well-formed values — an empty state machine, tick zero, no
 * record — so the panels render their document exactly as they would beside a
 * running simulation, simply with no live highlight. It returns a shared frozen
 * snapshot because an idle preview has no per-call state, and handing out a
 * fresh object each call would defeat the memoisation the panels already do.
 */
export function createIdleLivePreview(
  idleReason: IdleLivePreviewReason,
): IdleAnimationLivePreview {
  return {
    idle: true,
    idleReason,
    lastRecord: null,
    graphLayers: {},
    snapshot: () => IDLE_SNAPSHOT,
    // Nothing will ever fire, so the unsubscribe has nothing to undo.
    subscribe: () => () => {},
  };
}

/** Whether a preview is the idle stand-in rather than a running simulation. */
export function isIdleLivePreview(
  preview: AnimationLivePreview,
): preview is IdleAnimationLivePreview {
  return (preview as IdleAnimationLivePreview).idle === true;
}
