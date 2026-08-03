/**
 * The browser's relationship to the world runtime.
 *
 * Deliberately thin. It owns a fixed-step accumulator, polls the device once
 * per frame, and hands the resulting normalized intent to the runtime, which
 * decides which instance it reaches. Everything about *what happens next* lives
 * in `@atc/world-runtime`; nothing here decides simulation behaviour, which is
 * why this file has no knowledge of states, clips or transitions.
 */
import type { ProjectDefinition, WorldDefinition } from '@atc/schema';
import { FIXED_DT, FixedStepAccumulator } from '@atc/runtime-core';
import { BrowserInputSampler, type ActionSample } from '@atc/input-runtime';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import type { RootMotionTrack } from '@atc/replay-runtime';
import {
  WorldRuntime,
  observeWorld,
  type WorldObservation,
} from '@atc/world-runtime';
import type { CharacterPose } from '../three/characters/ProceduralCharacter.tsx';

/**
 * A temporary "show me this state now" override for one instance.
 *
 * It deliberately carries no authored data and is applied in `poseOf` —
 * *after* the simulation has stepped, on the read side — so previewing cannot
 * reach the fixed-step tick at all. That placement is the whole design: a
 * preview that forced a state into `Simulation.step` would change the tick
 * record, which is the thing replay determinism is measured against, and
 * "preview does not mutate canonical data" would become a claim about
 * discipline rather than a property of the code.
 */
export interface PreviewOverride {
  instanceId: string;
  layer: 'locomotion' | 'action';
  stateId: string;
  /** Advanced by the transport, not by the simulation clock. */
  normalizedTime: number;
  playing: boolean;
  loop: boolean;
  /** 1 = the clip's authored rate. */
  speed: number;
}

/** Seconds of preview time one normalized loop spans. Display-only. */
const PREVIEW_LOOP_SEC = 1;

/** Per-tick callbacks for `advance`. */
export interface AdvanceHooks {
  /** The normalized intent for the coming tick. Defaults to a device poll. */
  sample?: () => ActionSample;
  beforeTick?: (tick: number) => void;
  afterTick?: (tick: number) => void;
}

export interface WorldEngineOptions {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  world?: WorldDefinition;
}

export class WorldChamberEngine {
  private runtime: WorldRuntime;
  private readonly accumulator = new FixedStepAccumulator();
  private readonly sampler: BrowserInputSampler;
  private cameraYaw = 0;
  private preview: PreviewOverride | null = null;
  private readonly actionRootMotion = new Map<
    string,
    { enabled: boolean; tracks: Record<string, RootMotionTrack> }
  >();

  /**
   * True while a test driver owns tick advancement.
   *
   * Visual tests step the world by an exact number of ticks; letting wall-clock
   * deltas advance it at the same time is how a "deterministic" browser test
   * ends up racing the thing it is asserting about.
   */
  testDriven = false;

  constructor(private options: WorldEngineOptions) {
    this.runtime = new WorldRuntime(options);
    this.sampler = new BrowserInputSampler(options.project.inputMap);
  }

  attachInput(): void {
    this.sampler.attach();
  }

  detachInput(): void {
    this.sampler.detach();
  }

  get world(): WorldDefinition {
    return this.runtime.world;
  }

  get tick(): number {
    return this.runtime.tick;
  }

  get instanceIds(): readonly string[] {
    return this.runtime.instanceIds;
  }

  /** Rebuilds the world — used when a staged edit changes the definition. */
  setWorld(world: WorldDefinition): void {
    this.options = { ...this.options, world };
    this.runtime = new WorldRuntime(this.options);
    this.applyActionRootMotion();
  }

  /**
   * Pushes edited canonical data into the world, so tuning done in Focused is
   * what the world simulates.
   *
   * ponytail: rebuilds the runtime, which respawns every instance. Same
   * trade-off `setWorld` already makes. Re-resolve per instance and call
   * `Simulation.updateProject` if editing while the world runs needs to keep
   * positions.
   */
  setProject(project: ProjectDefinition): void {
    this.options = { ...this.options, project };
    this.runtime = new WorldRuntime(this.options);
    this.applyActionRootMotion();
    this.sampler.setInputMap(project.inputMap);
  }

  /**
   * Per-instance root motion tuning, the same values Isolate pushes into
   * `ChamberEngine`.
   *
   * Kept on the engine rather than handed straight to the simulation, because
   * `setWorld`/`setProject` rebuild the runtime: a value written only into the
   * live `Simulation` would vanish on the next tuning edit, which is exactly
   * when the human is watching for it.
   */
  setActionRootMotion(
    instanceId: string,
    config: { enabled: boolean; tracks: Record<string, RootMotionTrack> },
  ): void {
    this.actionRootMotion.set(instanceId, config);
    this.applyActionRootMotion();
  }

  private applyActionRootMotion(): void {
    for (const [instanceId, config] of this.actionRootMotion) {
      const simulation = this.runtime.instance(instanceId)?.simulation;
      if (!simulation) continue;
      simulation.setUpperBodyActionRootMotionEnabled(config.enabled);
      simulation.setActionRootMotionTracks(config.tracks);
    }
  }

  setCameraYaw(yawRad: number): void {
    this.cameraYaw = yawRad;
    this.runtime.setCameraYaw(yawRad);
  }

  get camera(): { yaw: number } {
    return { yaw: this.cameraYaw };
  }

  /**
   * Advances by whole fixed steps from a render delta.
   *
   * The hooks exist so a test can supply per-*tick* inputs rather than
   * per-frame ones. Cadence independence is the claim that identical per-tick
   * inputs produce identical results; a test that could only set an input once
   * per frame would be comparing three different input streams and calling the
   * difference a cadence bug.
   */
  advance(deltaSec: number, hooks: AdvanceHooks = {}): void {
    this.advancePreview(deltaSec);
    const steps = this.accumulator.advance(deltaSec);
    for (let i = 0; i < steps; i += 1) {
      hooks.beforeTick?.(this.runtime.tick);
      this.stepOnce(hooks.sample?.());
      hooks.afterTick?.(this.runtime.tick - 1);
    }
  }

  /** One instance's live runtime state, for pose reading and tests. */
  instance(instanceId: string) {
    return this.runtime.instance(instanceId);
  }

  /**
   * Installs or clears the preview override.
   *
   * Passing `null` is the "Clear preview" path, and it is the only state the
   * viewport can be left in by accident — so clearing restores the authored
   * behaviour completely rather than restoring a remembered pose.
   */
  setPreviewOverride(preview: PreviewOverride | null): void {
    this.preview = preview;
  }

  get previewOverride(): PreviewOverride | null {
    return this.preview;
  }

  /**
   * Advances preview time. Called from `advance` and from `stepOnce` so a
   * test-driven world — which never calls `advance` — can still step the
   * transport by an exact number of fixed steps.
   */
  advancePreview(deltaSec: number): void {
    const preview = this.preview;
    if (!preview || !preview.playing) return;
    const next = preview.normalizedTime + (deltaSec * preview.speed) / PREVIEW_LOOP_SEC;
    if (next < 1) {
      this.preview = { ...preview, normalizedTime: next };
    } else if (preview.loop) {
      this.preview = { ...preview, normalizedTime: next % 1 };
    } else {
      // Parking at the end rather than wrapping is what makes "Loop off" a
      // visible fact instead of a setting that looks broken.
      this.preview = { ...preview, normalizedTime: 1, playing: false };
    }
  }

  /** Exactly one fixed step. The test driver calls this directly. */
  stepOnce(sample?: ActionSample): void {
    // One poll, then routing. Instances never touch a device.
    const intent = sample ?? this.sampler.sample();
    this.runtime.injectLocalIntent(0, intent);
    this.runtime.step();
    if (this.testDriven) this.advancePreview(FIXED_DT);
  }

  observe(): WorldObservation {
    return observeWorld(this.runtime);
  }

  /**
   * A per-frame pose reader for one instance.
   *
   * Returned as a closure rather than a value so the renderer reads the latest
   * simulation state every frame without React re-rendering for each tick.
   */
  poseOf(instanceId: string): () => CharacterPose | null {
    return () => {
      const state = this.runtime.instance(instanceId);
      if (!state || !state.enabled) return null;
      const record = state.lastRecord;
      if (!record) {
        return this.applyPreview(instanceId, {
          position: state.definition.transform.position,
          yawRad: state.definition.transform.yawRad,
          locomotionState: 'idle',
          actionState: 'action-none',
          locomotionNormalizedTime: 0,
          actionNormalizedTime: 0,
          pelvisOffset: 0,
        });
      }
      return this.applyPreview(instanceId, {
        position: record.position,
        yawRad: record.yawRad,
        locomotionState: record.locomotionState,
        actionState: record.actionState,
        locomotionNormalizedTime: record.locomotionNormalizedTime,
        actionNormalizedTime: record.actionNormalizedTime,
        pelvisOffset: record.pelvisOffset,
      });
    };
  }

  /**
   * Substitutes the previewed state into a pose on its way to the renderer.
   *
   * Only the animation layer is replaced. Position and yaw keep coming from the
   * simulation, so a previewing instance still stands where the world says it
   * stands — previewing a clip is not a way to move something.
   */
  private applyPreview(instanceId: string, pose: CharacterPose): CharacterPose {
    const preview = this.preview;
    if (!preview || preview.instanceId !== instanceId) return pose;
    return preview.layer === 'locomotion'
      ? { ...pose, locomotionState: preview.stateId, locomotionNormalizedTime: preview.normalizedTime }
      : { ...pose, actionState: preview.stateId, actionNormalizedTime: preview.normalizedTime };
  }
}
