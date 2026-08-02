/**
 * The deterministic multi-instance world.
 *
 * One fixed-step clock, N instances, each owning its own `Simulation` and its
 * own intent source. The `Simulation` class was already the unit of mutable
 * character state, so this file does not reimplement a state machine — it owns
 * *which* simulations exist, what feeds them, and in what order they run.
 *
 * No DOM, no React, no Three.js, no filesystem. The browser drives this; it is
 * not part of it.
 */
import type {
  IntentTrackDefinition,
  ProjectDefinition,
  ReplayDefinition,
  ResolvedProject,
  TerrainPreset,
  WorldDefinition,
} from '@atc/schema';
import { Simulation, defaultEquipped, type TickRecord } from '@atc/replay-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import { ACTION_LAYER, LOCOMOTION_LAYER, type LayerId } from '@atc/animation-runtime';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import {
  InjectedIntentSource,
  NeutralIntentSource,
  ReplayIntentSource,
  ScriptedTrackIntentSource,
  neutralIntent,
  type IntentSource,
  type NormalizedIntent,
} from './intent.ts';
import { resolveWorld, worldOf, type ResolvedInstance } from './resolve.ts';
import type { WorldControlSource, WorldControlState } from './world-control.ts';

export interface WorldRuntimeOptions {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  /** Defaults to `worldOf(project)`. */
  world?: WorldDefinition;
  /** Recorded inputs available to `{ kind: 'replay' }` instances. */
  replays?: readonly ReplayDefinition[];
  terrain?: TerrainPreset;
  /**
   * Camera yaw, in radians. World-global rather than per-instance: movement is
   * camera-relative and there is one camera, so a per-instance value would let
   * two instances disagree about which way "forward" is while sharing a view.
   */
  cameraYawRad?: number;
  /**
   * World-global control input, sampled before every tick.
   *
   * Part of the *constructor* options rather than something attached
   * afterwards, because `reset()` rebuilds from these options and a control
   * source attached post-construction would silently disappear on reset —
   * turning "replay this again" into "replay this with the camera nailed to
   * zero". Sources must be stateless with respect to the tick so one can be
   * shared by a runtime and its reset without either advancing the other.
   */
  controlSource?: WorldControlSource;
}

/**
 * One instance's mutable runtime state.
 *
 * Every field here is per-instance by construction: there is no shared object
 * for two instances to reach through. The resolved *document* is shared, and it
 * is the only thing that is.
 */
export interface RuntimeInstanceState {
  readonly instanceId: string;
  readonly simulation: Simulation;
  readonly intentSource: IntentSource;
  /** The instance's declaration, including its authored spawn transform. */
  readonly definition: ResolvedInstance['definition'];
  /** This instance's own wrapper. Never shared with another instance. */
  readonly resolved: ResolvedProject;
  /** Identity of the shared animation bundle behind `resolved`. */
  readonly animationResolutionKey: string;
  enabled: boolean;
  lastRecord: TickRecord | null;
  lastIntent: NormalizedIntent;
}

/** A world tick, as the trace and the observation layer see it. */
export interface WorldTickRecord {
  tick: number;
  /**
   * The world-global control this tick actually consumed.
   *
   * Reported rather than inferred: a recorder that read the runtime's yaw
   * *before* calling `step` would capture the previous tick's value whenever
   * the value comes from a control source, which is sampled inside the step.
   * That is a one-tick shift that only appears on a re-record, which is the
   * least likely place anyone looks.
   */
  controls: WorldControlState;
  /** Instance id -> that instance's record. Disabled instances are absent. */
  instances: Record<string, TickRecord>;
}

export class WorldRuntime {
  private readonly order: string[] = [];
  private readonly states = new Map<string, RuntimeInstanceState>();
  private readonly definition: WorldDefinition;
  private readonly terrain: TerrainPreset;
  private tickIndex = 0;
  private cameraYaw = 0;
  private controls: WorldControlSource | null = null;

  constructor(private readonly options: WorldRuntimeOptions) {
    const resolution = resolveWorld({
      registry: options.registry,
      project: options.project,
      ...(options.world ? { world: options.world } : {}),
    });
    this.definition = resolution.world;
    this.terrain =
      options.terrain ?? findTerrainPreset(options.project.defaultTerrainPresetId);
    this.cameraYaw = options.cameraYawRad ?? 0;
    this.controls = options.controlSource ?? null;

    const tracks = new Map<string, IntentTrackDefinition>(
      this.definition.intentTracks.map((track) => [track.id, track]),
    );
    const replays = new Map<string, ReplayDefinition>(
      (options.replays ?? []).map((replay) => [replay.id, replay]),
    );

    for (const instance of resolution.instances) {
      const state = this.createInstanceState(instance, tracks, replays);
      this.order.push(state.instanceId);
      this.states.set(state.instanceId, state);
    }
  }

  private createInstanceState(
    instance: ResolvedInstance,
    tracks: ReadonlyMap<string, IntentTrackDefinition>,
    replays: ReadonlyMap<string, ReplayDefinition>,
  ): RuntimeInstanceState {
    const { definition, resolved } = instance;
    const overrides = definition.overrides ?? {};
    /*
     * The seed is per-instance and defaults to a hash of the instance id rather
     * than a constant. Two instances sharing a seed would be a defensible
     * default right up until a test asserted that they diverged, at which point
     * the identical RNG stream is the one thing that would make the assertion
     * pass for the wrong reason.
     */
    const simulation = new Simulation({
      project: resolved,
      terrain: this.terrain,
      seed: overrides.seed ?? seedOf(definition.id),
      initialPosition: { ...definition.transform.position },
      initialYawRad: definition.transform.yawRad,
      cameraYawRad: this.cameraYaw,
      ...(overrides.weaponModeId ? { weaponModeId: overrides.weaponModeId } : {}),
      equipped: { ...defaultEquipped(resolved), ...(overrides.equipped ?? {}) },
    });

    return {
      instanceId: definition.id,
      simulation,
      intentSource: buildIntentSource(definition.intentSource, tracks, replays),
      definition,
      resolved,
      animationResolutionKey: instance.animationResolutionKey,
      enabled: definition.enabled,
      lastRecord: null,
      lastIntent: neutralIntent(),
    };
  }

  /** The world this runtime was built from — explicit or synthesized. */
  get world(): WorldDefinition {
    return this.definition;
  }

  get tick(): number {
    return this.tickIndex;
  }

  /** Instance ids in tick order (declaration order). */
  get instanceIds(): readonly string[] {
    return this.order;
  }

  instance(instanceId: string): RuntimeInstanceState | undefined {
    return this.states.get(instanceId);
  }

  /**
   * Hands one frame of device intent to every instance bound to `playerIndex`.
   *
   * The host polls the device once and calls this; instances never poll. An
   * instance that reached for the keyboard itself would receive input based on
   * when it happened to tick, which is the bug this whole indirection exists to
   * make unrepresentable.
   */
  injectLocalIntent(playerIndex: number, intent: NormalizedIntent): void {
    for (const id of this.order) {
      const source = this.states.get(id)?.intentSource;
      if (source instanceof InjectedIntentSource && source.playerIndex === playerIndex) {
        source.inject(intent);
      }
    }
  }

  /**
   * Advances every enabled instance by exactly one fixed step.
   *
   * Iteration is over `this.order` — the canonical declaration order — and not
   * over the Map. Map order is insertion order today and would keep working by
   * accident, which is precisely why it is not what the loop reads.
   */
  step(): WorldTickRecord {
    /*
     * World-global controls first, and validated before anything moves. Camera
     * yaw decides what "forward" means for this tick, so applying it afterwards
     * would apply it one tick late — and a source that returns NaN must fail
     * the whole tick rather than leave the first two instances advanced and the
     * third not. `setCameraYaw` throws on a non-finite value, which is why it
     * is called before the loop and not inside it.
     */
    const controls: WorldControlState = this.controls
      ? this.controls.sample(this.tickIndex)
      : { cameraYawRad: this.cameraYaw };
    if (this.controls) this.setCameraYaw(controls.cameraYawRad);

    const instances: Record<string, TickRecord> = {};
    for (const id of this.order) {
      const state = this.states.get(id)!;
      if (!state.enabled) continue;
      const intent = state.intentSource.sample(this.tickIndex);
      state.lastIntent = intent;
      const record = state.simulation.step(intent);
      state.lastRecord = record;
      instances[id] = record;
    }
    const record: WorldTickRecord = { tick: this.tickIndex, controls, instances };
    this.tickIndex += 1;
    return record;
  }

  /** Runs `ticks` steps and returns every world record produced. */
  run(ticks: number): WorldTickRecord[] {
    const records: WorldTickRecord[] = [];
    for (let i = 0; i < ticks; i += 1) records.push(this.step());
    return records;
  }

  /**
   * World-global camera yaw, in radians.
   *
   * Exposed so a recorder can capture the value the tick actually ran with,
   * rather than the value the host believes it set.
   */
  get cameraYawRad(): number {
    return this.cameraYaw;
  }

  /**
   * Re-aims every instance's camera-relative movement.
   *
   * A non-finite yaw is refused rather than propagated: it would turn every
   * instance's position into NaN one tick later, with nothing left to say where
   * it came from.
   */
  setCameraYaw(yawRad: number): void {
    if (!Number.isFinite(yawRad)) {
      throw new Error(`camera yaw must be finite, received ${yawRad}`);
    }
    this.cameraYaw = yawRad;
    for (const id of this.order) this.states.get(id)!.simulation.setCameraYaw(yawRad);
  }

  /**
   * Binds a world-global control source for the *rest of this runtime's life*.
   *
   * `reset()` rebuilds from the constructor options, so a source assigned here
   * does **not** survive it — pass `controlSource` to the constructor for that.
   * Replay does exactly that; this setter exists for a host that wants to hand
   * over control mid-run and is expected to re-establish it itself.
   */
  setControlSource(source: WorldControlSource | null): void {
    this.controls = source;
  }

  setEnabled(instanceId: string, enabled: boolean): void {
    const state = this.states.get(instanceId);
    if (state) state.enabled = enabled;
  }

  /** Current animation layer state for an instance, for observation. */
  layerState(instanceId: string, layer: LayerId) {
    return this.states.get(instanceId)?.simulation.layerState(layer);
  }

  clipIdFor(instanceId: string, layer: LayerId): string | undefined {
    return this.states.get(instanceId)?.simulation.clipFor(layer)?.id;
  }

  /**
   * Rebuilds every instance from its authored transform at tick 0.
   *
   * A fresh `Simulation` rather than a mutation pass: `Simulation` has enough
   * private state that a hand-written reset would be a second, quietly
   * divergent constructor.
   */
  reset(): WorldRuntime {
    return new WorldRuntime(this.options);
  }
}

function buildIntentSource(
  definition: ResolvedInstance['definition']['intentSource'],
  tracks: ReadonlyMap<string, IntentTrackDefinition>,
  replays: ReadonlyMap<string, ReplayDefinition>,
): IntentSource {
  switch (definition.kind) {
    case 'local-input':
      return new InjectedIntentSource(definition.playerIndex);
    case 'scripted-track': {
      const track = tracks.get(definition.trackId);
      // A missing track is a validation failure, not a runtime crash: the world
      // still has to open so the human can see which reference is broken.
      return track ? new ScriptedTrackIntentSource(track) : new NeutralIntentSource();
    }
    case 'replay': {
      const replay = replays.get(definition.replayId);
      return replay ? new ReplayIntentSource(replay) : new NeutralIntentSource();
    }
    case 'none':
      return new NeutralIntentSource();
  }
}

/** Stable non-random seed derived from an instance id (FNV-1a). */
export function seedOf(instanceId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < instanceId.length; i += 1) {
    hash ^= instanceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Simulation seeds are positive 31-bit; 0 would be a legal but suspicious seed.
  return (hash % 2_147_483_646) + 1;
}

export { ACTION_LAYER, LOCOMOTION_LAYER, worldOf };
