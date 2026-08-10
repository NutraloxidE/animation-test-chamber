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
  TerrainPreset,
  TransformDefinition,
} from '@atc/schema';
import { quaternionToYaw } from '@atc/schema';
import {
  Simulation,
  defaultEquipped,
  type CharacterSimulationDocument,
  type RootMotionTrack,
  type TickRecord,
  type ExternalMotionFrame,
} from '@atc/replay-runtime';
import type { CharacterMotionCommand, GameplayCharacterSnapshot, GameplayCommandResult, GameplayIntentFrame } from '@atc/gameplay-sdk';
import { BUTTON_ACTIONS, type ButtonAction } from '@atc/schema';
import { DEFAULT_MOTION_CONTEXT_KEY } from '@atc/schema';
import { ACTION_LAYER, LOCOMOTION_LAYER, type LayerId } from '@atc/animation-runtime';
import {
  AiInjectedCharacterIntentSource,
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
  resolvedProject: CharacterSimulationDocument;
  /** The authored spawn transform. Yaw is projected from the quaternion. */
  initialTransform: TransformDefinition;
  terrain: TerrainPreset;
  intentSource: CharacterIntentSource;
  seed: number;
  overrides?: CharacterInstanceOverrides;
  /** Camera yaw at spawn; movement is camera-relative. */
  cameraYawRad?: number;
  /**
   * Root-motion policy, forwarded to `Simulation` unchanged.
   *
   * Passed through rather than re-modelled here. These are tuning decisions
   * that belong to the character's authored root-motion profile, and a second
   * representation of them at this boundary would be one more place for the two
   * to disagree about what "hybrid" means.
   */
  upperBodyActionRootMotionEnabled?: boolean;
  actionRootMotionContextKeys?: readonly string[];
  actionRootMotionTracks?: Record<string, RootMotionTrack>;
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
  readonly resolvedProject: CharacterSimulationDocument;
  /** The authored spawn transform, kept so `observe` can report authored scale. */
  readonly spawnTransform: TransformDefinition;

  private readonly simulationValue: Simulation;
  private source: CharacterIntentSource;
  private tickIndex = 0;
  private lastIntentValue: CharacterIntent = neutralIntent();
  private lastRecordValue: TickRecord | null = null;
  private enabledValue = true;
  private sequence = 0;
  private pending: Array<{ command: CharacterMotionCommand; componentId: string; key: string }> = [];
  private overrides: Array<{ command: Extract<CharacterMotionCommand, { type: 'motion-override' }>; componentId: string; key: string; remainingTicks: number }> = [];
  private scales: Array<{ command: Extract<CharacterMotionCommand, { type: 'movement-scale' }>; componentId: string; key: string; remainingTicks: number }> = [];
  private parameters = new Map<string, { value: boolean | number | string; remainingTicks?: number }>();
  private motionContextValue: string;

  constructor(private readonly options: ControllableCharacterOptions) {
    this.motionContextValue = options.overrides?.weaponModeId ?? DEFAULT_MOTION_CONTEXT_KEY;
    this.instanceId = options.instanceId;
    this.resolvedProject = options.resolvedProject;
    this.spawnTransform = options.initialTransform;
    this.source = options.intentSource;

    const overrides = options.overrides ?? {};
    this.simulationValue = new Simulation({
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
      ...(options.upperBodyActionRootMotionEnabled === undefined
        ? options.actionRootMotionContextKeys
          ? { upperBodyActionRootMotionEnabled: options.actionRootMotionContextKeys.includes(this.motionContextValue) }
          : {}
        : { upperBodyActionRootMotionEnabled: options.upperBodyActionRootMotionEnabled }),
      ...(options.actionRootMotionTracks ? { actionRootMotionTracks: options.actionRootMotionTracks } : {}),
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
   * The underlying `Simulation`.
   *
   * Exposed narrowly because `computeMetrics` needs the simulation itself to
   * read root-motion and foot-contact state that no `TickRecord` carries.
   * Reimplementing those metrics against the record list would produce a second
   * definition of "foot sliding" and the two would drift; handing over the
   * object the metrics were written against does not.
   *
   * Not a general escape hatch: stepping this directly bypasses the intent
   * source, which is the boundary this whole class exists to make unavoidable.
   */
  get simulation(): Simulation {
    return this.simulationValue;
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

  enqueueCommand(command: CharacterMotionCommand, componentId: string): GameplayCommandResult {
    if (!validCommand(command)) return { ok: false, code: 'invalid-command', message: 'motion command contains invalid values' };
    if (this.pending.filter((entry) => entry.componentId === componentId).length >= 16) return { ok: false, code: 'operation-budget-exceeded', message: 'script character command budget exceeded' };
    if (this.pending.length >= 64) return { ok: false, code: 'operation-budget-exceeded', message: 'character command budget exceeded' };
    this.pending.push({ command: structuredClone(command), componentId, key: `${componentId}/${'key' in command ? command.key : this.sequence++}` });
    return { ok: true };
  }

  setGameplayParameter(name: string, value: boolean | number | string, durationTicks?: number): GameplayCommandResult {
    if (!/^gameplay\.[A-Za-z][A-Za-z0-9._-]*$/.test(name) || (typeof value === 'number' && !Number.isFinite(value)) || (durationTicks !== undefined && (!Number.isInteger(durationTicks) || durationTicks <= 0))) return { ok: false, code: 'invalid-parameter-name', message: 'parameter must be gameplay.*, finite, and have a positive integer duration' };
    this.parameters.set(name, { value, ...(durationTicks === undefined ? {} : { remainingTicks: durationTicks }) });
    return { ok: true };
  }

  clearGameplayParameter(name: string): GameplayCommandResult { this.parameters.delete(name); return { ok: true }; }

  /**
   * Hands a Script-produced frame to an AI channel.
   *
   * Refused on any other source. A device, a track and a replay each already
   * *are* the answer to "what does this character want this tick", and a second
   * writer would make the winner depend on call order rather than on which
   * controller the Scene bound.
   */
  setScriptedIntent(frame: GameplayIntentFrame): GameplayCommandResult {
    const source = this.source;
    if (!(source instanceof AiInjectedCharacterIntentSource))
      return { ok: false, code: 'intent-not-scriptable', message: `intent source "${source.kind}" is not a scriptable AI channel` };
    const axis = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0);
    const intent = neutralIntent();
    intent.moveX = axis(frame.moveX);
    intent.moveY = axis(frame.moveY);
    intent.lookX = axis(frame.lookX);
    intent.lookY = axis(frame.lookY);
    for (const action of BUTTON_ACTIONS) intent.buttons[action as ButtonAction] = frame.buttons?.[action as ButtonAction] === true;
    source.inject(intent);
    return { ok: true };
  }

  /** The motion context the simulation currently resolves clips in. */
  get motionContextKey(): string { return this.motionContextValue; }

  /**
   * Switches the motion context.
   *
   * One call into the simulation rather than a parallel table here: the
   * simulation already re-resolves its document for a context, and a second
   * notion of "which context am I in" is how the renderer ends up drawing a
   * sword swing while the state machine steps an unarmed one.
   */
  setMotionContext(contextKey: string): GameplayCommandResult {
    if (typeof contextKey !== 'string' || contextKey.length === 0 || contextKey.length > 96)
      return { ok: false, code: 'invalid-command', message: 'motion context key must be a short non-empty string' };
    if (contextKey === this.motionContextValue) return { ok: true };
    this.motionContextValue = contextKey;
    this.simulationValue.setWeaponModeId(contextKey);
    if (this.options.actionRootMotionContextKeys) {
      this.simulationValue.setUpperBodyActionRootMotionEnabled(
        this.options.actionRootMotionContextKeys.includes(contextKey),
      );
    }
    return { ok: true };
  }

  /** Advances exactly one fixed step. */
  step(tick: number, context: CharacterControlContext): CharacterTickRecord {
    this.simulationValue.setCameraYaw(context.cameraYawRad);
    const intent = this.source.sample(tick);
    this.lastIntentValue = intent;
    const frame = this.consumeCommands(context.cameraYawRad);
    const record = this.simulationValue.step(intent, frame);
    this.lastRecordValue = record;
    this.tickIndex = tick + 1;
    return { tick, intent, record };
  }

  private consumeCommands(cameraYawRad: number): ExternalMotionFrame {
    let teleport: ExternalMotionFrame['teleport'];
    let impulse = { x: 0, y: 0, z: 0 };
    for (const entry of this.pending.sort((a, b) => a.key.localeCompare(b.key))) {
      const command = entry.command;
      if (command.type === 'impulse') impulse = add(impulse, inWorld(command.deltaVelocity, command.space, this.simulationValue.state.yawRad, cameraYawRad));
      else if (command.type === 'teleport' && !teleport) teleport = { position: command.position, ...(command.yawRad === undefined ? {} : { yawRad: command.yawRad }), clearVelocity: command.velocity === 'clear' };
      else if (command.type === 'motion-override') this.replaceTimed(this.overrides, { command, componentId: entry.componentId, key: entry.key, remainingTicks: command.durationTicks });
      else if (command.type === 'movement-scale') this.replaceTimed(this.scales, { command, componentId: entry.componentId, key: entry.key, remainingTicks: command.durationTicks });
    }
    this.pending = [];
    const sortedOverrides = [...this.overrides].sort((a, b) => (b.command.priority ?? 0) - (a.command.priority ?? 0) || a.key.localeCompare(b.key));
    const replacement = sortedOverrides.find((x) => x.command.horizontal === 'replace');
    const vertical = sortedOverrides.find((x) => x.command.vertical === 'replace');
    let additive = impulse;
    for (const entry of [...this.overrides].sort((a, b) => a.key.localeCompare(b.key))) if (entry.command.horizontal === 'add' || entry.command.vertical === 'add') {
      const value = inWorld(entry.command.velocity, entry.command.space, this.simulationValue.state.yawRad, cameraYawRad);
      additive = add(additive, { x: entry.command.horizontal === 'add' ? value.x : 0, y: entry.command.vertical === 'add' ? value.y : 0, z: entry.command.horizontal === 'add' ? value.z : 0 });
    }
    const sortedScales = [...this.scales].sort((a, b) => (b.command.priority ?? 0) - (a.command.priority ?? 0) || a.key.localeCompare(b.key));
    const speedScale = sortedScales[0]?.command.speedScale;
    const accelerationScale = sortedScales.find((entry) => entry.command.accelerationScale !== undefined)?.command.accelerationScale;
    const turnScale = sortedScales.find((entry) => entry.command.turnScale !== undefined)?.command.turnScale;
    const parameters = Object.fromEntries([...this.parameters].map(([name, entry]) => [name, entry.value]));
    const frame: ExternalMotionFrame = { addVelocity: additive, gameplayParameters: parameters, ...(teleport ? { teleport } : {}), ...(speedScale === undefined ? {} : { speedScale }), ...(accelerationScale === undefined ? {} : { accelerationScale }), ...(turnScale === undefined ? {} : { turnScale }) };
    const replacementVelocity = replacement ? inWorld(replacement.command.velocity, replacement.command.space, this.simulationValue.state.yawRad, cameraYawRad) : undefined;
    if (replacementVelocity) frame.replaceHorizontal = replacementVelocity;
    if (vertical) frame.replaceVertical = inWorld(vertical.command.velocity, vertical.command.space, this.simulationValue.state.yawRad, cameraYawRad).y;
    const facing = sortedOverrides.find((entry) => entry.command.facing !== undefined && entry.command.facing !== 'preserve');
    if (facing?.command.facing === 'velocity') {
      const velocity = inWorld(facing.command.velocity, facing.command.space, this.simulationValue.state.yawRad, cameraYawRad);
      if (Math.hypot(velocity.x, velocity.z) > 1e-6) frame.facingYawRad = Math.atan2(velocity.x, velocity.z);
    } else if (facing?.command.facing && typeof facing.command.facing === 'object') frame.facingYawRad = facing.command.facing.yawRad;
    for (const entry of this.overrides) entry.remainingTicks -= 1;
    for (const entry of this.scales) entry.remainingTicks -= 1;
    this.overrides = this.overrides.filter((entry) => entry.remainingTicks > 0);
    this.scales = this.scales.filter((entry) => entry.remainingTicks > 0);
    for (const [name, entry] of this.parameters) if (entry.remainingTicks !== undefined && --entry.remainingTicks <= 0) this.parameters.delete(name);
    return frame;
  }

  private replaceTimed<T extends { componentId: string; command: { key: string } }>(items: T[], next: T): void { const index = items.findIndex((item) => item.componentId === next.componentId && item.command.key === next.command.key); if (index < 0) items.push(next); else items[index] = next; }

  layerState(layer: LayerId) {
    return this.simulationValue.layerState(layer);
  }

  clipIdFor(layer: LayerId): string | undefined {
    return this.simulationValue.clipFor(layer)?.id;
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
      locomotionStateId: this.simulationValue.layerState(LOCOMOTION_LAYER)?.stateId ?? '',
      actionStateId: this.simulationValue.layerState(ACTION_LAYER)?.stateId ?? '',
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

  gameplaySnapshot(): GameplayCharacterSnapshot {
    const observed = this.observe();
    return { tick: observed.tick, worldTransform: observed.transform, velocity: observed.velocity, grounded: observed.grounded, locomotionStateId: observed.locomotionStateId, actionStateId: observed.actionStateId, intentSourceKind: observed.intentSourceKind, motionContextKey: this.motionContextValue, gameplayParameters: Object.fromEntries([...this.parameters].map(([name, entry]) => [name, entry.value])), activeMotionOverrides: this.overrides.map((entry) => ({ key: entry.command.key, sourceComponentId: entry.componentId, remainingTicks: entry.remainingTicks, priority: entry.command.priority ?? 0 })), activeMovementScales: this.scales.map((entry) => ({ key: entry.command.key, sourceComponentId: entry.componentId, remainingTicks: entry.remainingTicks, priority: entry.command.priority ?? 0 })) };
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

function validVec(value: { x: number; y: number; z: number }): boolean { return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z); }
function validCommand(command: CharacterMotionCommand): boolean { if (command.type === 'impulse') return validVec(command.deltaVelocity); if (command.type === 'teleport') return validVec(command.position) && (command.yawRad === undefined || Number.isFinite(command.yawRad)); if (!command.key || !Number.isInteger(command.durationTicks) || command.durationTicks <= 0 || Math.abs(command.priority ?? 0) > 1000) return false; return command.type === 'movement-scale' ? [command.speedScale, command.accelerationScale ?? 1, command.turnScale ?? 1].every((x) => Number.isFinite(x) && x >= 0) : validVec(command.velocity); }
function add(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function inWorld(value: { x: number; y: number; z: number }, space: 'world' | 'facing' | 'camera', facing: number, camera: number) { if (space === 'world') return { ...value }; const yaw = space === 'facing' ? facing : camera; const cos = Math.cos(yaw); const sin = Math.sin(yaw); return { x: value.x * cos + value.z * sin, y: value.y, z: -value.x * sin + value.z * cos }; }

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
