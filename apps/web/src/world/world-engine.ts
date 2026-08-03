/**
 * The browser's relationship to the world runtime.
 *
 * Deliberately thin. It owns a fixed-step accumulator, polls the device once
 * per frame, and hands the resulting normalized intent to the runtime, which
 * decides which instance it reaches. Everything about *what happens next* lives
 * in `@atc/world-runtime`; nothing here decides simulation behaviour, which is
 * why this file has no knowledge of states, clips or transitions.
 */
import type { ProjectDefinition, ResolvedProject, WorldDefinition } from '@atc/schema';
import { FIXED_DT, FixedStepAccumulator } from '@atc/runtime-core';
import { BrowserInputSampler, type ActionSample } from '@atc/input-runtime';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
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
  /**
   * Playhead position in *seconds of clip time*, advanced by the transport
   * rather than by the simulation clock.
   *
   * Seconds, not a normalized fraction, because the transport previously
   * advanced a 0..1 loop against a fixed one-second span: a 0.35 s attack and a
   * 1.20 s dodge both took exactly one second at speed 1, and the control was
   * labelled "authored rate" while being the one thing it could not be. The
   * normalized value the renderer wants is derived from this and the clip's own
   * duration, so there is one clock and it is the one with units.
   */
  timeSec: number;
  /** The resolved clip's authored duration. 0 means nothing is bound. */
  durationSec: number;
  playing: boolean;
  loop: boolean;
  /** 1 = the clip's authored duration. 0.5 takes twice as long. */
  speed: number;
}

/** Normalized position of a preview playhead. Safe for a zero-length clip. */
export function previewNormalizedTime(preview: {
  timeSec: number;
  durationSec: number;
}): number {
  if (!(preview.durationSec > 0)) return 0;
  return Math.max(0, Math.min(preview.timeSec / preview.durationSec, 1));
}

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
   * The document this instance's simulation is actually running.
   *
   * Read-only, and the reason the animation tools have a resolver seam at all:
   * `WorldRuntime` resolved every instance when it built the world, so asking
   * it is the only way to be sure a panel is describing the behaviour that is
   * running rather than one resolved a second time from the same inputs. The
   * value is immutable — a resolved document is rebuilt, never mutated — so
   * handing it out cannot become a way to reach the live simulation.
   */
  resolvedProjectFor(instanceId: string): ResolvedProject | null {
    return this.runtime.instance(instanceId)?.resolved ?? null;
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
    // A state whose motion slot resolves to nothing has no clip time to
    // advance. Playing it would otherwise divide by zero and park the playhead
    // at NaN, which renders as a frozen pose with nothing to point at.
    if (!(preview.durationSec > 0) || !Number.isFinite(deltaSec)) return;
    // A non-finite or negative speed is clamped rather than propagated: it
    // reaches the playhead, and a NaN there is unrecoverable without a reset.
    const speed = Number.isFinite(preview.speed) ? Math.max(0, preview.speed) : 0;
    const next = preview.timeSec + deltaSec * speed;
    if (next < preview.durationSec) {
      this.preview = { ...preview, timeSec: next };
    } else if (preview.loop) {
      this.preview = { ...preview, timeSec: next % preview.durationSec };
    } else {
      // Parking at the end rather than wrapping is what makes "Loop off" a
      // visible fact instead of a setting that looks broken.
      this.preview = { ...preview, timeSec: preview.durationSec, playing: false };
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
    const normalized = previewNormalizedTime(preview);
    return preview.layer === 'locomotion'
      ? { ...pose, locomotionState: preview.stateId, locomotionNormalizedTime: normalized }
      : { ...pose, actionState: preview.stateId, actionNormalizedTime: normalized };
  }
}
