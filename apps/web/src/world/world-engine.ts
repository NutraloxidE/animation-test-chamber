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
import { FixedStepAccumulator } from '@atc/runtime-core';
import { BrowserInputSampler, type ActionSample } from '@atc/input-runtime';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import {
  WorldRuntime,
  observeWorld,
  type WorldObservation,
} from '@atc/world-runtime';
import type { CharacterPose } from '../three/characters/ProceduralCharacter.tsx';

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

  /** Advances by whole fixed steps from a render delta. */
  advance(deltaSec: number): void {
    const steps = this.accumulator.advance(deltaSec);
    for (let i = 0; i < steps; i += 1) this.stepOnce();
  }

  /** Exactly one fixed step. The test driver calls this directly. */
  stepOnce(sample?: ActionSample): void {
    // One poll, then routing. Instances never touch a device.
    const intent = sample ?? this.sampler.sample();
    this.runtime.injectLocalIntent(0, intent);
    this.runtime.step();
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
        return {
          position: state.definition.transform.position,
          yawRad: state.definition.transform.yawRad,
          locomotionState: 'idle',
          actionState: 'action-none',
          locomotionNormalizedTime: 0,
          actionNormalizedTime: 0,
          pelvisOffset: 0,
        };
      }
      return {
        position: record.position,
        yawRad: record.yawRad,
        locomotionState: record.locomotionState,
        actionState: record.actionState,
        locomotionNormalizedTime: record.locomotionNormalizedTime,
        actionNormalizedTime: record.actionNormalizedTime,
        pelvisOffset: record.pelvisOffset,
      };
    };
  }
}
