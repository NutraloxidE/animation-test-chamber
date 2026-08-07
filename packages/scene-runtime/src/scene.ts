/**
 * The deterministic Scene runtime.
 *
 * One fixed-step clock, N entities, each character owning its own
 * `ControllableCharacter` and therefore its own `Simulation` and intent source.
 * This file does not reimplement a state machine — it owns *which* characters
 * exist, what feeds them, and in what order they run.
 *
 * Props, lights and cameras are projections, not participants. Forcing every
 * scene entity through `ControllableCharacter` would give a crate an intent
 * source and a state machine, which is a general ECS wearing the wrong name.
 *
 * No DOM, no React, no Three.js, no filesystem. The browser drives this; it is
 * not part of it.
 */
import type {
  CameraSceneEntity,
  IntentTrackDefinition,
  LightSceneEntity,
  ProjectDefinition,
  PropSceneEntity,
  ReplayDefinition,
  SceneDefinition,
  TerrainPreset,
} from '@atc/schema';
import type { TickRecord } from '@atc/replay-runtime';
import { findTerrainPreset } from '@atc/terrain-runtime';
import { ACTION_LAYER, LOCOMOTION_LAYER, type LayerId } from '@atc/animation-runtime';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import {
  AiInjectedCharacterIntentSource,
  ControllableCharacter,
  InjectedCharacterIntentSource,
  buildCharacterIntentSource,
  seedOf,
  type CharacterIntent,
} from '@atc/character-control-runtime';
import { resolveScene, type ResolvedSceneCharacter } from './resolve.ts';
import type { SceneControlSource, SceneControlState } from './control.ts';

export interface SceneRuntimeOptions {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  /** The scene to run — canonical or staged. Never mutated. */
  scene: SceneDefinition;
  /** Recorded inputs available to `{ kind: 'replay' }` entities. */
  replays?: readonly ReplayDefinition[];
  terrain?: TerrainPreset;
  /**
   * Camera yaw, in radians. Scene-global rather than per-entity: movement is
   * camera-relative and there is one camera, so a per-entity value would let
   * two characters disagree about which way "forward" is while sharing a view.
   */
  cameraYawRad?: number;
  /**
   * Scene-global control input, sampled before every tick.
   *
   * Part of the *constructor* options rather than something attached
   * afterwards, because `reset()` rebuilds from these options and a control
   * source attached post-construction would silently disappear on reset —
   * turning "replay this again" into "replay this with the camera nailed to
   * zero".
   */
  controlSource?: SceneControlSource;
}

/** An entity that resolved to nothing runnable. Inspectable, never substituted. */
export interface UnresolvedSceneEntity {
  entityId: string;
  characterId: string;
  reason: string;
}

/** Non-ticking entities, projected for a renderer and an inspector. */
export interface SceneProjections {
  props: PropSceneEntity[];
  lights: LightSceneEntity[];
  cameras: CameraSceneEntity[];
}

/** A scene tick, as the trace and the observation layer see it. */
export interface SceneTickRecord {
  tick: number;
  /**
   * The scene-global control this tick actually consumed.
   *
   * Reported rather than inferred: a recorder that read the runtime's yaw
   * *before* calling `step` would capture the previous tick's value whenever
   * the value comes from a control source, which is sampled inside the step.
   */
  controls: SceneControlState;
  /** Entity id -> that character's record. Disabled entities are absent. */
  entities: Record<string, TickRecord>;
}

export class SceneRuntime {
  private readonly order: string[] = [];
  private readonly characters = new Map<string, ControllableCharacter>();
  private readonly resolvedById = new Map<string, ResolvedSceneCharacter>();
  private readonly definition: SceneDefinition;
  private readonly terrain: TerrainPreset;
  private readonly unresolvedEntities: UnresolvedSceneEntity[] = [];
  private tickIndex = 0;
  private cameraYaw = 0;
  private controls: SceneControlSource | null = null;

  constructor(private readonly options: SceneRuntimeOptions) {
    this.definition = options.scene;
    this.terrain = options.terrain ?? findTerrainPreset(options.project.defaultTerrainPresetId);
    this.cameraYaw = options.cameraYawRad ?? 0;
    this.controls = options.controlSource ?? null;

    const resolution = resolveScene({
      registry: options.registry,
      project: options.project,
      scene: options.scene,
    });

    const tracks = new Map<string, IntentTrackDefinition>(
      this.definition.intentTracks.map((track) => [track.id, track]),
    );
    const replays = new Map<string, ReplayDefinition>(
      (options.replays ?? []).map((replay) => [replay.id, replay]),
    );

    const resolvedIds = new Set(resolution.characters.map((entry) => entry.definition.id));
    for (const entity of this.definition.entities) {
      if (entity.kind !== 'character' || resolvedIds.has(entity.id)) continue;
      this.unresolvedEntities.push({
        entityId: entity.id,
        characterId: entity.characterId,
        reason: `unknown character "${entity.characterId}"`,
      });
    }

    for (const entry of resolution.characters) {
      const { definition } = entry;
      const character = new ControllableCharacter({
        instanceId: definition.id,
        resolvedProject: entry.resolved,
        initialTransform: definition.transform,
        terrain: this.terrain,
        intentSource: buildCharacterIntentSource(definition.controller, tracks, replays),
        seed: definition.overrides?.seed ?? seedOf(definition.id),
        cameraYawRad: this.cameraYaw,
        ...(definition.overrides ? { overrides: definition.overrides } : {}),
      });
      character.enabled = definition.enabled;
      this.order.push(definition.id);
      this.characters.set(definition.id, character);
      this.resolvedById.set(definition.id, entry);
    }
  }

  get scene(): SceneDefinition {
    return this.definition;
  }

  get tick(): number {
    return this.tickIndex;
  }

  /** Character entity ids in tick order (declaration order). */
  get entityIds(): readonly string[] {
    return this.order;
  }

  /** Entities that name a character the project does not have. */
  get unresolved(): readonly UnresolvedSceneEntity[] {
    return this.unresolvedEntities;
  }

  character(entityId: string): ControllableCharacter | undefined {
    return this.characters.get(entityId);
  }

  resolvedCharacter(entityId: string): ResolvedSceneCharacter | undefined {
    return this.resolvedById.get(entityId);
  }

  /** Props, lights and cameras, in declaration order. They do not tick. */
  projections(): SceneProjections {
    return {
      props: this.definition.entities.filter(
        (entity): entity is PropSceneEntity => entity.kind === 'prop',
      ),
      lights: this.definition.entities.filter(
        (entity): entity is LightSceneEntity => entity.kind === 'light',
      ),
      cameras: this.definition.entities.filter(
        (entity): entity is CameraSceneEntity => entity.kind === 'camera',
      ),
    };
  }

  /**
   * Hands one frame of device intent to every character bound to `playerIndex`.
   *
   * The host polls the device once and calls this; characters never poll. A
   * character that reached for the keyboard itself would receive input based on
   * when it happened to tick, which is the bug this indirection exists to make
   * unrepresentable.
   */
  injectHumanIntent(playerIndex: number, intent: CharacterIntent): void {
    for (const id of this.order) {
      const source = this.characters.get(id)?.intentSource;
      if (
        source instanceof InjectedCharacterIntentSource &&
        !(source instanceof AiInjectedCharacterIntentSource) &&
        source.playerIndex === playerIndex
      ) {
        source.inject(intent);
      }
    }
  }

  /**
   * Hands one frame of AI intent to every character bound to `channelId`.
   *
   * Routed on the source *class* rather than on a player index, so
   * `injectHumanIntent(0, …)` can never reach an AI channel that happens to
   * carry the same number.
   */
  injectAiIntent(channelId: string, intent: CharacterIntent): void {
    for (const id of this.order) {
      const source = this.characters.get(id)?.intentSource;
      if (source instanceof AiInjectedCharacterIntentSource && source.channelId === channelId) {
        source.inject(intent);
      }
    }
  }

  /**
   * Advances every enabled character by exactly one fixed step.
   *
   * Iteration is over `this.order` — the canonical declaration order — and not
   * over the Map. Map order is insertion order today and would keep working by
   * accident, which is precisely why it is not what the loop reads.
   */
  step(): SceneTickRecord {
    /*
     * Scene-global controls first, and validated before anything moves. Camera
     * yaw decides what "forward" means for this tick, so applying it afterwards
     * would apply it one tick late — and a source that returns NaN must fail
     * the whole tick rather than leave the first two characters advanced and
     * the third not.
     */
    const controls: SceneControlState = this.controls
      ? this.controls.sample(this.tickIndex)
      : { cameraYawRad: this.cameraYaw };
    if (this.controls) this.setCameraYaw(controls.cameraYawRad);

    const entities: Record<string, TickRecord> = {};
    for (const id of this.order) {
      const character = this.characters.get(id)!;
      if (!character.enabled) continue;
      entities[id] = character.step(this.tickIndex, { cameraYawRad: this.cameraYaw }).record;
    }
    const record: SceneTickRecord = { tick: this.tickIndex, controls, entities };
    this.tickIndex += 1;
    return record;
  }

  /** Runs `ticks` steps and returns every scene record produced. */
  run(ticks: number): SceneTickRecord[] {
    const records: SceneTickRecord[] = [];
    for (let i = 0; i < ticks; i += 1) records.push(this.step());
    return records;
  }

  get cameraYawRad(): number {
    return this.cameraYaw;
  }

  /**
   * Re-aims every character's camera-relative movement.
   *
   * A non-finite yaw is refused rather than propagated: it would turn every
   * character's position into NaN one tick later, with nothing left to say
   * where it came from.
   */
  setCameraYaw(yawRad: number): void {
    if (!Number.isFinite(yawRad)) {
      throw new Error(`camera yaw must be finite, received ${yawRad}`);
    }
    this.cameraYaw = yawRad;
  }

  /**
   * Binds a scene-global control source for the *rest of this runtime's life*.
   *
   * `reset()` rebuilds from the constructor options, so a source assigned here
   * does **not** survive it — pass `controlSource` to the constructor for that.
   */
  setControlSource(source: SceneControlSource | null): void {
    this.controls = source;
  }

  setEnabled(entityId: string, enabled: boolean): void {
    const character = this.characters.get(entityId);
    if (character) character.enabled = enabled;
  }

  layerState(entityId: string, layer: LayerId) {
    return this.characters.get(entityId)?.layerState(layer);
  }

  clipIdFor(entityId: string, layer: LayerId): string | undefined {
    return this.characters.get(entityId)?.clipIdFor(layer);
  }

  /**
   * Rebuilds every character from its authored transform at tick 0.
   *
   * A fresh runtime rather than a mutation pass: `Simulation` has enough
   * private state that a hand-written reset would be a second, quietly
   * divergent constructor.
   */
  reset(): SceneRuntime {
    return new SceneRuntime(this.options);
  }
}

export { ACTION_LAYER, LOCOMOTION_LAYER, seedOf };
