/**
 * `ControllableCharacter` — the only normal character-control boundary.
 *
 * One mutable `Simulation`, one intent source, one identity. Every controller a
 * character can have arrives here as normalized intent:
 *
 *     keyboard / gamepad ─┐
 *     AI channel ─────────┤
 *     scripted track ─────┼→ CharacterIntentSource → ControllableCharacter
 *     replay ─────────────┤                              ↓
 *     network injection ──┘                   state machine / movement
 *                                                        ↓
 *                                               animation graph / pose
 *
 * The character is tuned once and every controller benefits from that tuning.
 * The alternative — an AI that calls `playAnimation("dodge")` — bypasses the
 * transition rules, input windows, equipment context and root-motion policy the
 * tuning *is*, and produces a character that behaves one way for a human and
 * another way for everything else.
 *
 * This file owns no clock. Ticks arrive from outside, which is what lets one
 * scene, one rig preview, and one headless test all drive the same class.
 *
 * No DOM, no React, no Three.js, no filesystem, no Git.
 */
import type {
  CharacterInstanceOverrides,
  ResolvedProject,
  TerrainPreset,
  TransformDefinition,
} from '@atc/schema';
import { quaternionToYaw } from '@atc/schema';
import { Simulation, defaultEquipped, type TickRecord } from '@atc/replay-runtime';
import { ACTION_LAYER, LOCOMOTION_LAYER, type LayerId } from '@atc/animation-runtime';
import {
  NeutralCharacterIntentSource,
  neutralIntent,
  type CharacterIntent,
  type CharacterIntentSource,
} from './intent.ts';

export interface ControllableCharacterOptions {
  /** Scene entity id, or a rig-preview id. Stable, and never an array index. */
  instanceId: string;
  /**
   * This character's own resolved document.
   *
   * Never shared with another character, even when two characters resolve to
   * the same animation bundle: it carries the character's id, display name,
   * model path and capsule dimensions, and two different characters on one
   * animation set must not receive each other's body.
   */
  resolvedProject: ResolvedProject;
  /** The authored spawn transform. Yaw is projected from the quaternion. */
  initialTransform: TransformDefinition;
  terrain: TerrainPreset;
  intentSource: CharacterIntentSource;
  seed: number;
  overrides?: CharacterInstanceOverrides;
  /** Camera yaw at spawn; movement is camera-relative. */
  cameraYawRad?: number;
}

/** Per-tick context the host supplies. */
export interface CharacterControlContext {
  /**
   * Camera yaw, in radians.
   *
   * Passed in per tick rather than held here, because it decides what "forward"
   * means and there is one camera for a whole scene. A per-character copy would
   * let two characters sharing a view disagree about which way forward is.
   */
  cameraYawRad: number;
}

/** What a character did on one tick, plus the intent that caused it. */
export interface CharacterTickRecord {
  tick: number;
  intent: CharacterIntent;
  record: TickRecord;
}

export interface CharacterObservation {
  instanceId: string;
  tick: number;
  /** Current transform. Rotation is the authored spawn rotation re-aimed by yaw. */
  transform: TransformDefinition;
  intentSourceKind: string;
  intentCursor: number;
  lastIntent: CharacterIntent;
  locomotionStateId: string;
  actionStateId: string;
  /** Layer id -> clip id, or null when the layer is not currently playing one. */
  clipIds: Record<string, string | null>;
  velocity: { x: number; y: number; z: number };
  grounded: boolean;
  enabled: boolean;
  /**
   * Absent until the character has stepped at least once.
   *
   * Reported as absent rather than as zeroes: a character that has never
   * ticked has no events, and a caller reading `[]` cannot tell that from a
   * character that ticked and produced none.
   */
  events?: string[];
}

export class ControllableCharacter {
  readonly instanceId: string;
  readonly resolvedProject: ResolvedProject;
  /** The authored spawn transform, kept so `observe` can report authored scale. */
  readonly spawnTransform: TransformDefinition;

  private readonly simulation: Simulation;
  private source: CharacterIntentSource;
  private tickIndex = 0;
  private lastIntentValue: CharacterIntent = neutralIntent();
  private lastRecordValue: TickRecord | null = null;
  private enabledValue = true;

  constructor(private readonly options: ControllableCharacterOptions) {
    this.instanceId = options.instanceId;
    this.resolvedProject = options.resolvedProject;
    this.spawnTransform = options.initialTransform;
    this.source = options.intentSource;

    const overrides = options.overrides ?? {};
    this.simulation = new Simulation({
      project: options.resolvedProject,
      terrain: options.terrain,
      seed: options.seed,
      initialPosition: { ...options.initialTransform.position },
      /*
       * The scene stores a full rotation; this runtime is yaw-only. The yaw is
       * projected out of the authored quaternion rather than the document being
       * narrowed to what the runtime supports, so a scene that later grows a
       * pitched character still has its authored rotation on disk.
       */
      initialYawRad: quaternionToYaw(options.initialTransform.rotation),
      cameraYawRad: options.cameraYawRad ?? 0,
      ...(overrides.weaponModeId ? { weaponModeId: overrides.weaponModeId } : {}),
      equipped: { ...defaultEquipped(options.resolvedProject), ...(overrides.equipped ?? {}) },
    });
  }

  get tick(): number {
    return this.tickIndex;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  set enabled(next: boolean) {
    this.enabledValue = next;
  }

  get intentSource(): CharacterIntentSource {
    return this.source;
  }

  get lastIntent(): CharacterIntent {
    return this.lastIntentValue;
  }

  get lastRecord(): TickRecord | null {
    return this.lastRecordValue;
  }

  /**
   * Swaps the source mid-run, for a host handing control over.
   *
   * `reset()` rebuilds from the constructor options, so a source assigned here
   * does not survive it — which is deliberate: a reset that kept a
   * post-construction source would replay a recording with a different
   * controller than the one that recorded it.
   */
  setIntentSource(source: CharacterIntentSource): void {
    this.source = source;
  }

  /**
   * Hands one frame of intent to an injected source.
   *
   * A no-op on a scripted or replay source rather than an error: a host that
   * polls a device every frame and fans it out should not have to know which
   * characters happen to be script-driven this tick.
   */
  injectIntent(intent: CharacterIntent): void {
    const source = this.source as { inject?: (intent: CharacterIntent) => void };
    source.inject?.(intent);
  }

  /** Advances exactly one fixed step. */
  step(tick: number, context: CharacterControlContext): CharacterTickRecord {
    this.simulation.setCameraYaw(context.cameraYawRad);
    const intent = this.source.sample(tick);
    this.lastIntentValue = intent;
    const record = this.simulation.step(intent);
    this.lastRecordValue = record;
    this.tickIndex = tick + 1;
    return { tick, intent, record };
  }

  layerState(layer: LayerId) {
    return this.simulation.layerState(layer);
  }

  clipIdFor(layer: LayerId): string | undefined {
    return this.simulation.clipFor(layer)?.id;
  }

  observe(): CharacterObservation {
    const record = this.lastRecordValue;
    return {
      instanceId: this.instanceId,
      tick: this.tickIndex,
      transform: {
        position: record ? { ...record.position } : { ...this.spawnTransform.position },
        rotation: record
          ? yawAsQuaternion(record.yawRad)
          : { ...this.spawnTransform.rotation },
        scale: { ...this.spawnTransform.scale },
      },
      intentSourceKind: this.source.kind,
      intentCursor: this.source.cursor(),
      lastIntent: this.lastIntentValue,
      locomotionStateId: this.simulation.layerState(LOCOMOTION_LAYER)?.stateId ?? '',
      actionStateId: this.simulation.layerState(ACTION_LAYER)?.stateId ?? '',
      clipIds: {
        [LOCOMOTION_LAYER]: this.clipIdFor(LOCOMOTION_LAYER) ?? null,
        [ACTION_LAYER]: this.clipIdFor(ACTION_LAYER) ?? null,
      },
      velocity: record ? { ...record.velocity } : { x: 0, y: 0, z: 0 },
      grounded: record?.grounded ?? true,
      enabled: this.enabledValue,
      ...(record ? { events: [...record.events] } : {}),
    };
  }

  /**
   * Rebuilds this character at tick 0 from its authored spawn transform.
   *
   * A fresh instance rather than a mutation pass: `Simulation` has enough
   * private state that a hand-written reset would be a second, quietly
   * divergent constructor — and the intent source is reset with it, so no
   * cursor leaks across the boundary.
   */
  reset(): ControllableCharacter {
    this.source.reset();
    return new ControllableCharacter(this.options);
  }
}

function yawAsQuaternion(yawRad: number): TransformDefinition['rotation'] {
  const half = yawRad / 2;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/**
 * Stable non-random seed derived from an entity id (FNV-1a).
 *
 * Per-character and defaulting to a hash of the id rather than to a constant.
 * Two characters sharing a seed would be a defensible default right up until a
 * test asserted that they diverged, at which point the identical RNG stream is
 * the one thing that would make the assertion pass for the wrong reason.
 */
export function seedOf(instanceId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < instanceId.length; i += 1) {
    hash ^= instanceId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Simulation seeds are positive 31-bit; 0 would be a legal but suspicious seed.
  return (hash % 2_147_483_646) + 1;
}

/** A neutral-source character, for a preview that has no controller yet. */
export function neutralSource(): CharacterIntentSource {
  return new NeutralCharacterIntentSource();
}
