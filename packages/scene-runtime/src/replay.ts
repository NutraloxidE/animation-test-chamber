/**
 * Scene replay: recording and playing back multi-character runs.
 *
 * DECISION 0010 chose *versioning over rewriting*. The legacy
 * `ReplayDefinition` is unchanged and every existing fixture still means what
 * it meant; a scene replay is a new, versioned container holding one legacy
 * replay per entity, keyed by entity id. Every frame therefore identifies
 * its target entity by construction — there is no shared frame stream in
 * which a frame could be ambiguous about who it was for.
 *
 * The alternative, one flat frame list with an `instanceId` column, would have
 * been a smaller diff and would have made "replay only this entity" a filter
 * over the whole file rather than a lookup.
 */
import type { CharacterSceneEntity, ProjectDefinition, ReplayDefinition, SceneDefinition } from '@atc/schema';
import { quaternionToYaw } from '@atc/schema';
import { FIXED_TIMESTEP_VERSION } from '@atc/schema';
import { ReplayRecorder } from '@atc/replay-runtime';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import { SceneRuntime, seedOf, type SceneRuntimeOptions } from './scene.ts';
import {
  ControlTrackRecorder,
  RecordedControlSource,
  validateControlTrack,
  type SceneControlKeyframe,
} from './control.ts';

/**
 * 1 -> 2: a recording carries a scene-global camera-yaw track.
 *
 * Version 1 recorded per-entity intent only and wrote camera yaw as a
 * constant zero, so a run recorded while the camera turned replayed as if it
 * had not. A v1 recording is still readable — it is *interpreted* as constant
 * yaw zero, which is exactly what it meant — and any other version is refused
 * rather than guessed at.
 */
export const SCENE_REPLAY_VERSION = 2;

/** Versions `createReplayRuntime` knows how to interpret. */
export const SUPPORTED_SCENE_REPLAY_VERSIONS = [1, SCENE_REPLAY_VERSION] as const;

export interface SceneReplay {
  sceneReplayVersion: number;
  fixedTimestepVersion: number;
  sceneId: string;
  tickCount: number;
  /** Entity id -> the normalized input that character received. */
  entities: Record<string, ReplayDefinition>;
  /** Declaration order at record time, so playback ticks in the same order. */
  entityOrder: string[];
  /**
   * Scene-global control input. Camera yaw belongs here rather than in a
   * per-entity stream because movement is camera-relative and there is one
   * camera: recording it per entity would let two characters replay with
   * different ideas of forward.
   */
  controls: { cameraYaw: SceneControlKeyframe[] };
}

/**
 * Records every character's *normalized* intent as the scene ticks.
 *
 * Normalized, not device events: a recording made of keydowns could only be
 * replayed in a browser, and would say nothing about what a gamepad or a
 * scripted track had asked for.
 */
export class SceneReplayRecorder {
  private readonly recorders = new Map<string, ReplayRecorder>();
  private readonly controls = new ControlTrackRecorder();
  private ticks = 0;

  constructor(private readonly runtime: SceneRuntime) {
    for (const id of runtime.entityIds) {
      const state = runtime.resolvedCharacter(id)!;
      this.recorders.set(
        id,
        new ReplayRecorder({
          id,
          label: state.definition.displayName,
          revisionId: state.resolved.revisionId,
          seed: state.definition.overrides?.seed ?? seedOf(id),
          terrainPresetId: state.resolved.defaultTerrainPresetId,
          initialPosition: { ...state.definition.transform.position },
          initialYawRad: quaternionToYaw(state.definition.transform.rotation),
          cameraYawRad: 0,
        }),
      );
    }
  }

  /**
   * Steps the scene and records what the tick actually ran with.
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
      recorder.record(this.runtime.character(id)!.lastIntent);
    }
    this.ticks += 1;
  }

  run(ticks: number): void {
    for (let i = 0; i < ticks; i += 1) this.step();
  }

  finish(): SceneReplay {
    const entities: Record<string, ReplayDefinition> = {};
    for (const [id, recorder] of this.recorders) entities[id] = recorder.finish();
    return {
      sceneReplayVersion: SCENE_REPLAY_VERSION,
      fixedTimestepVersion: FIXED_TIMESTEP_VERSION,
      sceneId: this.runtime.scene.id,
      tickCount: Math.max(1, this.ticks),
      entities,
      entityOrder: [...this.runtime.entityIds],
      controls: { cameraYaw: this.controls.finish() },
    };
  }
}

/**
 * Builds a runtime that plays a scene replay back.
 *
 * Every character is rebound to its own recorded stream. Nothing else about the
 * scene changes — the same definitions, the same order, the same transforms —
 * so a difference between the recorded run and the replayed one is a
 * difference in the simulation and cannot be a difference in the setup.
 */
export function createReplayRuntime(options: {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  scene: SceneDefinition;
  replay: SceneReplay;
}): SceneRuntime {
  const version = options.replay.sceneReplayVersion;
  if (!SUPPORTED_SCENE_REPLAY_VERSIONS.includes(version as 1 | 2)) {
    throw new Error(
      `unsupported sceneReplayVersion ${version}; this build reads ${SUPPORTED_SCENE_REPLAY_VERSIONS.join(', ')}`,
    );
  }
  // A v1 recording predates the control track and meant constant yaw zero.
  const cameraYaw = version === SCENE_REPLAY_VERSION ? (options.replay.controls?.cameraYaw ?? []) : [];
  const controlIssues = validateControlTrack(cameraYaw, options.replay.tickCount);
  if (controlIssues.length > 0) {
    throw new Error(
      `invalid scene replay controls: ${controlIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
    );
  }

  const scene: SceneDefinition = {
    ...options.scene,
    entities: options.scene.entities.map((entity) =>
      entity.kind === 'character' && options.replay.entities[entity.id]
        ? ({
            ...entity,
            controller: { kind: 'replay' as const, replayId: entity.id },
          } satisfies CharacterSceneEntity)
        : entity,
    ),
  };
  const runtimeOptions: SceneRuntimeOptions = {
    registry: options.registry,
    project: options.project,
    scene,
    replays: Object.values(options.replay.entities),
    /*
     * Constructor configuration, not a post-construction attachment. `reset()`
     * rebuilds from these options, so a source bound afterwards would vanish on
     * reset and the replayed camera would silently flatten to zero — a failure
     * that only shows up on the second run of the same recording.
     */
    controlSource: new RecordedControlSource(cameraYaw),
  };
  return new SceneRuntime(runtimeOptions);
}
