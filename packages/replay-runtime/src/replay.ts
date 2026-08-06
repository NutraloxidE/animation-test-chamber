import type {
  ReplayDefinition,
  ReplayFrame,
  ReplayTolerance,
  SemanticEventKind,
  TerrainPreset,
} from '@atc/schema';
import { FIXED_TIMESTEP_VERSION } from '@atc/schema';
import { FIXED_DT, quantize } from '@atc/runtime-core';
import { emptySample, frameToSample, sampleToFrame, type ActionSample } from '@atc/input-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import {
  Simulation,
  type CharacterSimulationDocument,
  type TickRecord,
} from './simulation.ts';

/** Aggregate quality numbers for a run (PLAN 11.5). Advisory, never the verdict. */
export interface ReplayMetrics {
  footSlidingDistance: number;
  footFloatingTicks: number;
  maxPenetration: number;
  groundedFlickerCount: number;
  pelvisJerk: number;
  rootMotionError: number;
  landingStabilizationTicks: number;
  movingPlatformDrift: number;
  finalPosition: { x: number; y: number; z: number };
  /** Distinct locomotion states entered, in order. */
  stateSequence: string[];
  /** Distinct action-layer states entered, in order. Combos assert on this. */
  actionSequence: string[];
  /** Semantic events with the tick they fired on. */
  eventTimeline: { tick: number; event: SemanticEventKind }[];
}

export interface ReplayTrace {
  replayId: string;
  revisionId: string;
  fixedTimestepVersion: number;
  ticks: TickRecord[];
  metrics: ReplayMetrics;
}

/**
 * Input for a given tick.
 *
 * Replay frames are sparse — one is stored only when the input actually changes
 * — so the correct sample for a tick is the most recent frame at or before it,
 * not an exact match. Doing an exact match here would silently feed empty input
 * on every unrecorded tick, which is how live replay playback in the browser
 * would end up disagreeing with the headless run of the same file.
 */
export function frameAt(replay: ReplayDefinition, tick: number): ActionSample {
  let held: ReplayFrame | null = null;
  for (const frame of replay.frames) {
    if (frame.tick > tick) continue;
    if (!held || frame.tick > held.tick) held = frame;
  }
  return held ? frameToSample(held) : emptySample();
}

/**
 * Runs a replay to completion and produces the trace used for regression
 * comparison. Nothing here reads wall-clock time, so the result depends only on
 * the project revision and the replay file.
 */
/**
 * What replaying needs: a document the simulation can run, plus the revision it
 * came from.
 *
 * The revision is the replay's, not the simulation's — a trace records what it
 * was produced against so a later comparison can say whether the two runs are
 * even commensurable. Keeping it here rather than on
 * `CharacterSimulationDocument` leaves the simulation's own requirements
 * honest.
 */
export interface ReplayDocument extends CharacterSimulationDocument {
  revisionId: string;
}

export function runReplay(
  project: ReplayDocument,
  replay: ReplayDefinition,
  terrain?: TerrainPreset,
): ReplayTrace {
  const preset = terrain ?? findTerrainPreset(replay.terrainPresetId);

  const simulation = new Simulation({
    project,
    terrain: preset,
    seed: replay.seed,
    initialPosition: replay.initialPosition,
    initialYawRad: replay.initialYawRad,
    cameraYawRad: replay.cameraYawRad,
  });

  // Frames are sparse: a frame is only stored when input changed, and the last
  // known sample is held until the next one.
  const sorted = [...replay.frames].sort((a, b) => a.tick - b.tick);
  let cursor = 0;
  let held: ActionSample = emptySample();

  const ticks: TickRecord[] = [];
  for (let tick = 0; tick < replay.tickCount; tick += 1) {
    while (cursor < sorted.length && sorted[cursor]!.tick <= tick) {
      held = frameToSample(sorted[cursor]!);
      cursor += 1;
    }
    ticks.push(simulation.step(held));
  }

  return {
    replayId: replay.id,
    revisionId: project.revisionId,
    fixedTimestepVersion: FIXED_TIMESTEP_VERSION,
    ticks,
    metrics: computeMetrics(ticks, simulation),
  };
}

/**
 * Aggregate metrics for a finished run.
 *
 * Exported because a world trace has to produce the *same* metrics per instance
 * as a legacy single-character trace does. A second copy of this arithmetic in
 * the world package would be the fastest possible way to make the projection
 * test pass while the two traces quietly measured different things.
 */
export function computeMetrics(ticks: TickRecord[], simulation: Simulation): ReplayMetrics {
  let footSlidingDistance = 0;
  let footFloatingTicks = 0;
  let maxPenetration = 0;
  let groundedFlickerCount = 0;
  let pelvisJerk = 0;
  let landingStabilizationTicks = 0;

  const stateSequence: string[] = [];
  const actionSequence: string[] = [];
  const eventTimeline: { tick: number; event: SemanticEventKind }[] = [];

  let previousGrounded = ticks[0]?.grounded ?? true;
  let previousPelvis = ticks[0]?.pelvisOffset ?? 0;
  let previousPelvisVelocity = 0;
  let landingTick: number | null = null;

  for (const record of ticks) {
    footSlidingDistance += record.footSlidingDistance;
    if (record.floating > 0.005) footFloatingTicks += 1;
    if (record.penetration > maxPenetration) maxPenetration = record.penetration;

    if (record.grounded !== previousGrounded) {
      groundedFlickerCount += 1;
      previousGrounded = record.grounded;
    }

    const pelvisVelocity = (record.pelvisOffset - previousPelvis) / FIXED_DT;
    pelvisJerk += Math.abs(pelvisVelocity - previousPelvisVelocity);
    previousPelvis = record.pelvisOffset;
    previousPelvisVelocity = pelvisVelocity;

    if (stateSequence[stateSequence.length - 1] !== record.locomotionState) {
      stateSequence.push(record.locomotionState);
    }
    if (actionSequence[actionSequence.length - 1] !== record.actionState) {
      actionSequence.push(record.actionState);
    }

    for (const event of record.events) {
      eventTimeline.push({ tick: record.tick, event });
      if (event === 'Landing') landingTick = record.tick;
    }

    // Stabilization ends once the character is grounded and horizontally settled.
    if (landingTick !== null && record.tick > landingTick) {
      const settled = record.grounded && Math.abs(record.velocity.y) < 0.01;
      if (settled) {
        landingStabilizationTicks = record.tick - landingTick;
        landingTick = null;
      }
    }
  }

  const state = simulation.state;
  const rootMotionError = Math.abs(state.authoredRootDisplacement - state.actualDisplacement);

  // Drift while riding a platform: how far the character moved relative to it.
  const platformTicks = ticks.filter((record) => record.terrainState === 'OnMovingPlatform');
  const movingPlatformDrift =
    platformTicks.length > 1
      ? Math.hypot(
          platformTicks[platformTicks.length - 1]!.position.x - platformTicks[0]!.position.x,
          platformTicks[platformTicks.length - 1]!.position.z - platformTicks[0]!.position.z,
        )
      : 0;

  return {
    footSlidingDistance: quantize(footSlidingDistance, 4),
    footFloatingTicks,
    maxPenetration: quantize(maxPenetration, 4),
    groundedFlickerCount,
    pelvisJerk: quantize(pelvisJerk, 3),
    rootMotionError: quantize(rootMotionError, 4),
    landingStabilizationTicks,
    movingPlatformDrift: quantize(movingPlatformDrift, 4),
    finalPosition: ticks[ticks.length - 1]?.position ?? { x: 0, y: 0, z: 0 },
    stateSequence,
    actionSequence,
    eventTimeline,
  };
}

export interface TraceDifference {
  kind: 'state-sequence' | 'position' | 'event-timing' | 'event-missing' | 'foot-metric';
  tick: number | null;
  message: string;
  expected: string;
  actual: string;
}

export interface TraceComparison {
  identical: boolean;
  differences: TraceDifference[];
}

export const DEFAULT_TOLERANCE: ReplayTolerance = {
  positionMeters: 0.001,
  eventTicks: 1,
  footSlidingMeters: 0.01,
};

/**
 * Compares two traces. A difference is never auto-accepted as the new truth
 * (PLAN 13.3) — this only reports, and the caller decides what to do.
 */
export function compareTraces(
  expected: ReplayTrace,
  actual: ReplayTrace,
  tolerance: ReplayTolerance = DEFAULT_TOLERANCE,
): TraceComparison {
  const differences: TraceDifference[] = [];

  // Both layers matter: a combo or cancel change shows up only in the action
  // layer, and comparing locomotion alone would call that "identical".
  const layers = [
    { name: 'locomotion', expected: expected.metrics.stateSequence, actual: actual.metrics.stateSequence },
    { name: 'action', expected: expected.metrics.actionSequence, actual: actual.metrics.actionSequence },
  ];
  for (const layer of layers) {
    const expectedStates = layer.expected.join(' -> ');
    const actualStates = layer.actual.join(' -> ');
    if (expectedStates !== actualStates) {
      differences.push({
        kind: 'state-sequence',
        tick: null,
        message: `${layer.name} state sequence changed`,
        expected: expectedStates,
        actual: actualStates,
      });
    }
  }

  const tickCount = Math.min(expected.ticks.length, actual.ticks.length);
  for (let i = 0; i < tickCount; i += 1) {
    const a = expected.ticks[i]!;
    const b = actual.ticks[i]!;
    const delta = Math.hypot(
      a.position.x - b.position.x,
      a.position.y - b.position.y,
      a.position.z - b.position.z,
    );
    if (delta > tolerance.positionMeters) {
      differences.push({
        kind: 'position',
        tick: i,
        message: `position diverged by ${delta.toFixed(4)}m`,
        expected: formatVec(a.position),
        actual: formatVec(b.position),
      });
      // One report per run is enough; the rest is noise.
      break;
    }
  }

  for (const expectedEvent of expected.metrics.eventTimeline) {
    const match = actual.metrics.eventTimeline.find(
      (candidate) =>
        candidate.event === expectedEvent.event &&
        Math.abs(candidate.tick - expectedEvent.tick) <= tolerance.eventTicks,
    );
    if (!match) {
      differences.push({
        kind: 'event-missing',
        tick: expectedEvent.tick,
        message: `event ${expectedEvent.event} missing within ${tolerance.eventTicks} tick(s)`,
        expected: `${expectedEvent.event}@${expectedEvent.tick}`,
        actual: 'not fired',
      });
    }
  }

  const slidingDelta = Math.abs(
    expected.metrics.footSlidingDistance - actual.metrics.footSlidingDistance,
  );
  if (slidingDelta > tolerance.footSlidingMeters) {
    differences.push({
      kind: 'foot-metric',
      tick: null,
      message: 'foot sliding distance changed beyond tolerance',
      expected: expected.metrics.footSlidingDistance.toFixed(4),
      actual: actual.metrics.footSlidingDistance.toFixed(4),
    });
  }

  return { identical: differences.length === 0, differences };
}

function formatVec(v: { x: number; y: number; z: number }): string {
  return `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
}

/**
 * Records live input into a replay. Frames are only appended when the sample
 * actually changes, which keeps recorded files small and readable in a diff.
 */
export class ReplayRecorder {
  private readonly frames: ReplayFrame[] = [];
  private previous: string | null = null;
  private tick = 0;

  constructor(
    private readonly meta: {
      id: string;
      label: string;
      revisionId: string;
      seed: number;
      terrainPresetId: string;
      initialPosition: { x: number; y: number; z: number };
      initialYawRad: number;
      cameraYawRad: number;
    },
  ) {}

  record(sample: ActionSample): void {
    const frame = sampleToFrame(this.tick, sample);
    const key = `${frame.moveX}|${frame.moveY}|${frame.lookX}|${frame.lookY}|${frame.buttons}`;
    if (key !== this.previous) {
      this.frames.push(frame);
      this.previous = key;
    }
    this.tick += 1;
  }

  get tickCount(): number {
    return this.tick;
  }

  finish(): ReplayDefinition {
    return {
      schemaVersion: 1,
      id: this.meta.id,
      label: this.meta.label,
      revisionId: this.meta.revisionId,
      fixedTimestepVersion: FIXED_TIMESTEP_VERSION,
      seed: this.meta.seed,
      terrainPresetId: this.meta.terrainPresetId,
      initialPosition: this.meta.initialPosition,
      initialYawRad: this.meta.initialYawRad,
      cameraYawRad: this.meta.cameraYawRad,
      tickCount: Math.max(1, this.tick),
      frames: this.frames,
    };
  }
}
