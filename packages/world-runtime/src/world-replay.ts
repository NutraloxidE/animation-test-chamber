/**
 * World replay: recording and playing back multi-instance runs.
 *
 * DECISION 0010 chose *versioning over rewriting*. The legacy
 * `ReplayDefinition` is unchanged and every existing fixture still means what
 * it meant; a world replay is a new, versioned container holding one legacy
 * replay per instance, keyed by instance id. Every frame therefore identifies
 * its target instance by construction — there is no shared frame stream in
 * which a frame could be ambiguous about who it was for.
 *
 * The alternative, one flat frame list with an `instanceId` column, would have
 * been a smaller diff and would have made "replay only this instance" a filter
 * over the whole file rather than a lookup.
 */
import type { ProjectDefinition, ReplayDefinition, WorldDefinition } from '@atc/schema';
import { FIXED_TIMESTEP_VERSION } from '@atc/schema';
import { ReplayRecorder } from '@atc/replay-runtime';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import { WorldRuntime, seedOf, type WorldRuntimeOptions } from './world.ts';
import {
  ControlTrackRecorder,
  RecordedControlSource,
  validateControlTrack,
  type WorldControlKeyframe,
} from './world-control.ts';

/**
 * 1 -> 2: a recording carries a world-global camera-yaw track.
 *
 * Version 1 recorded per-instance intent only and wrote camera yaw as a
 * constant zero, so a run recorded while the camera turned replayed as if it
 * had not. A v1 recording is still readable — it is *interpreted* as constant
 * yaw zero, which is exactly what it meant — and any other version is refused
 * rather than guessed at.
 */
export const WORLD_REPLAY_VERSION = 2;

/** Versions `createReplayRuntime` knows how to interpret. */
export const SUPPORTED_WORLD_REPLAY_VERSIONS = [1, WORLD_REPLAY_VERSION] as const;

export interface WorldReplay {
  worldReplayVersion: number;
  fixedTimestepVersion: number;
  worldId: string;
  tickCount: number;
  /** Instance id -> the normalized input that instance received. */
  instances: Record<string, ReplayDefinition>;
  /** Declaration order at record time, so playback ticks in the same order. */
  instanceOrder: string[];
  /**
   * World-global control input. Camera yaw belongs here rather than in a
   * per-instance stream because movement is camera-relative and there is one
   * camera: recording it per instance would let two instances replay with
   * different ideas of forward.
   */
  controls: { cameraYaw: WorldControlKeyframe[] };
}

/**
 * Records every instance's *normalized* intent as the world ticks.
 *
 * Normalized, not device events: a recording made of keydowns could only be
 * replayed in a browser, and would say nothing about what a gamepad or a
 * scripted track had asked for.
 */
export class WorldReplayRecorder {
  private readonly recorders = new Map<string, ReplayRecorder>();
  private readonly controls = new ControlTrackRecorder();
  private ticks = 0;

  constructor(private readonly runtime: WorldRuntime) {
    for (const id of runtime.instanceIds) {
      const state = runtime.instance(id)!;
      this.recorders.set(
        id,
        new ReplayRecorder({
          id,
          label: state.definition.displayName,
          revisionId: state.resolved.revisionId,
          seed: state.definition.overrides?.seed ?? seedOf(id),
          terrainPresetId: state.resolved.defaultTerrainPresetId,
          initialPosition: { ...state.definition.transform.position },
          initialYawRad: state.definition.transform.yawRad,
          cameraYawRad: 0,
        }),
      );
    }
  }

  /**
   * Steps the world and records what the tick actually ran with.
   *
   * The camera yaw comes from the *returned tick record*, not from the runtime
   * before or after the step. Reading it beforehand was correct only for a
   * host-driven run, where the host sets the yaw first; for a runtime driven by
   * a control source — every replay — the source is sampled inside `step`, so
   * the pre-step value is the previous tick's and every re-record shifted the
   * camera track one tick later.
   */
  step(): void {
    const record = this.runtime.step();
    this.controls.record(record.tick, record.controls.cameraYawRad);
    for (const [id, recorder] of this.recorders) {
      const state = this.runtime.instance(id)!;
      recorder.record(state.lastIntent);
    }
    this.ticks += 1;
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i += 1) this.step();
  }

  finish(): WorldReplay {
    const instances: Record<string, ReplayDefinition> = {};
    for (const [id, recorder] of this.recorders) instances[id] = recorder.finish();
    return {
      worldReplayVersion: WORLD_REPLAY_VERSION,
      fixedTimestepVersion: FIXED_TIMESTEP_VERSION,
      worldId: this.runtime.world.id,
      tickCount: Math.max(1, this.ticks),
      instances,
      instanceOrder: [...this.runtime.instanceIds],
      controls: { cameraYaw: this.controls.finish() },
    };
  }
}

/**
 * Builds a runtime that plays a world replay back.
 *
 * Every instance is rebound to its own recorded stream. Nothing else about the
 * world changes — the same definitions, the same order, the same transforms —
 * so a difference between the recorded run and the replayed one is a
 * difference in the simulation and cannot be a difference in the setup.
 */
export function createReplayRuntime(options: {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  world: WorldDefinition;
  replay: WorldReplay;
}): WorldRuntime {
  const version = options.replay.worldReplayVersion;
  if (!SUPPORTED_WORLD_REPLAY_VERSIONS.includes(version as 1 | 2)) {
    throw new Error(
      `unsupported worldReplayVersion ${version}; this build reads ${SUPPORTED_WORLD_REPLAY_VERSIONS.join(', ')}`,
    );
  }
  // A v1 recording predates the control track and meant constant yaw zero.
  const cameraYaw = version === WORLD_REPLAY_VERSION ? (options.replay.controls?.cameraYaw ?? []) : [];
  const controlIssues = validateControlTrack(cameraYaw, options.replay.tickCount);
  if (controlIssues.length > 0) {
    throw new Error(
      `invalid world replay controls: ${controlIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
  }

  const world: WorldDefinition = {
    ...options.world,
    instances: options.world.instances.map((instance) =>
      options.replay.instances[instance.id]
        ? { ...instance, intentSource: { kind: 'replay' as const, replayId: instance.id } }
        : instance,
    ),
  };
  const runtimeOptions: WorldRuntimeOptions = {
    registry: options.registry,
    project: options.project,
    world,
    replays: Object.values(options.replay.instances),
    /*
     * Constructor configuration, not a post-construction attachment. `reset()`
     * rebuilds from these options, so a source bound afterwards would vanish on
     * reset and the replayed camera would silently flatten to zero — a failure
     * that only shows up on the second run of the same recording.
     */
    controlSource: new RecordedControlSource(cameraYaw),
  };
  return new WorldRuntime(runtimeOptions);
}
