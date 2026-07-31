import { Type, type Static } from '@sinclair/typebox';
import {
  CurveKind,
  Id,
  NormalizedTime,
  NormalizedWindow,
  ProtectionMetadata,
  SchemaVersion,
  ValueProvenance,
  Vec3,
} from './common.ts';

/** Semantic events (PLAN 12.1). Hitbox, audio, VFX and haptics all reference these. */
export const SemanticEventKind = Type.Union(
  [
    Type.Literal('FootContactLeft'),
    Type.Literal('FootContactRight'),
    Type.Literal('AttackWindup'),
    Type.Literal('AttackHit'),
    Type.Literal('AttackRecoil'),
    Type.Literal('JumpTakeoff'),
    Type.Literal('Landing'),
    Type.Literal('DamageReceived'),
    Type.Literal('DodgeStart'),
    Type.Literal('DodgeEnd'),
    Type.Literal('GuardImpact'),
  ],
  { $id: 'SemanticEventKind' },
);
export type SemanticEventKind = Static<typeof SemanticEventKind>;

export const SemanticEventDefinition = Type.Object(
  {
    id: Id,
    kind: SemanticEventKind,
    /** Position within the owning clip, normalized. */
    at: NormalizedTime,
    payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'SemanticEventDefinition', additionalProperties: false },
);
export type SemanticEventDefinition = Static<typeof SemanticEventDefinition>;

export const SkeletonBone = Type.Object(
  {
    name: Type.String(),
    parent: Type.Union([Type.String(), Type.Null()]),
    /** Canonical humanoid slot this bone maps to, if any. */
    humanoid: Type.Optional(Type.String()),
    restPosition: Vec3,
  },
  { $id: 'SkeletonBone', additionalProperties: false },
);
export type SkeletonBone = Static<typeof SkeletonBone>;

export const SkeletonDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    /** Meters from foot to top of head; used to normalize retargeted clips. */
    height: Type.Number({ minimum: 0.1, maximum: 10 }),
    bones: Type.Array(SkeletonBone),
    leftFootBone: Type.String(),
    rightFootBone: Type.String(),
    hipsBone: Type.String(),
  },
  { $id: 'SkeletonDefinition', additionalProperties: false },
);
export type SkeletonDefinition = Static<typeof SkeletonDefinition>;

/** How a clip's root displacement is authored. */
export const RootMotionMode = Type.Union(
  [Type.Literal('InPlace'), Type.Literal('RootMotion'), Type.Literal('Hybrid')],
  { $id: 'RootMotionMode' },
);
export type RootMotionMode = Static<typeof RootMotionMode>;

export const RootMotionCurve = Type.Union(
  [Type.Literal('Linear'), Type.Literal('FastInSlowOut')],
  { $id: 'RootMotionCurve' },
);
export type RootMotionCurve = Static<typeof RootMotionCurve>;

/** CSS-style cubic Bézier timing curve. Endpoints are fixed at (0,0) and (1,1). */
export const ClipTimeCurve = Type.Object(
  {
    x1: NormalizedTime,
    y1: NormalizedTime,
    x2: NormalizedTime,
    y2: NormalizedTime,
  },
  { $id: 'ClipTimeCurve', additionalProperties: false },
);
export type ClipTimeCurve = Static<typeof ClipTimeCurve>;

export const AnimationClipDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    /** Asset reference, or null when the procedural fallback clip is used. */
    assetPath: Type.Union([Type.String(), Type.Null()]),
    /** Procedural generator name used when assetPath is null. */
    proceduralGenerator: Type.Optional(Type.String()),
    durationSec: Type.Number({ minimum: 0.01, maximum: 120 }),
    loop: Type.Boolean(),
    /** Optional nonlinear mapping from elapsed time to sampled animation time. */
    timeCurve: Type.Optional(ClipTimeCurve),
    /** Authored root displacement over the whole clip, in meters. */
    rootDisplacement: Vec3,
    rootMotionMode: RootMotionMode,
    /** Optional timing curve applied without changing total displacement. */
    rootMotionCurve: Type.Optional(RootMotionCurve),
    /** Normalized point where a moving dodge begins blending back to locomotion. */
    recoveryTransitionStartNormalized: Type.Optional(
      Type.Number({ minimum: 0, maximum: 1 }),
    ),
    /** Earliest normalized time at which a new action-button press is buffered. */
    inputAcceptanceStartNormalized: Type.Optional(NormalizedTime),
    /** Rotation authority multiplier while this clip is still playing. */
    rotationScaleWhilePlaying: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    events: Type.Array(SemanticEventDefinition),
    /** Normalized times at which each foot is planted. Drives foot-IK and metrics. */
    footContacts: Type.Object(
      {
        left: Type.Array(NormalizedWindow),
        right: Type.Array(NormalizedWindow),
      },
      { additionalProperties: false },
    ),
    protection: Type.Optional(ProtectionMetadata),
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'AnimationClipDefinition', additionalProperties: false },
);
export type AnimationClipDefinition = Static<typeof AnimationClipDefinition>;

export const ConditionOperator = Type.Union(
  [
    Type.Literal('equals'),
    Type.Literal('notEquals'),
    Type.Literal('greaterThan'),
    Type.Literal('lessThan'),
    Type.Literal('greaterOrEqual'),
    Type.Literal('lessOrEqual'),
    Type.Literal('buffered'),
  ],
  { $id: 'ConditionOperator' },
);
export type ConditionOperator = Static<typeof ConditionOperator>;

export const TransitionCondition = Type.Object(
  {
    parameter: Type.String({ minLength: 1 }),
    operator: ConditionOperator,
    value: Type.Union([Type.Number(), Type.Boolean(), Type.String()]),
  },
  { $id: 'TransitionCondition', additionalProperties: false },
);
export type TransitionCondition = Static<typeof TransitionCondition>;

/** Per-weapon-mode overrides for the timing of a single transition. */
export const TransitionWeaponOverride = Type.Object(
  {
    blendDurationSec: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
    exitTimeNormalized: Type.Optional(NormalizedTime),
    inputBufferMs: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
    cancelWindow: Type.Optional(NormalizedWindow),
  },
  { $id: 'TransitionWeaponOverride', additionalProperties: false },
);
export type TransitionWeaponOverride = Static<typeof TransitionWeaponOverride>;

export const TransitionDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    /** Source state id, or "*" for a limited global interrupt (PLAN 7.1). */
    from: Type.String({ minLength: 1 }),
    to: Id,
    conditions: Type.Array(TransitionCondition),
    blendDurationSec: Type.Number({ minimum: 0, maximum: 2 }),
    /** Where in the destination clip playback begins. */
    startOffsetNormalized: NormalizedTime,
    /** Earliest normalized time in the source state at which this may fire. */
    exitTimeNormalized: Type.Optional(NormalizedTime),
    playbackSpeed: Type.Number({ minimum: 0.05, maximum: 4 }),
    /** Fraction of horizontal velocity carried across the transition. */
    momentumRetention: Type.Number({ minimum: 0, maximum: 1 }),
    /** How much the character may steer during the destination state. */
    rotationAuthority: Type.Number({ minimum: 0, maximum: 1 }),
    /** May this transition itself be interrupted while blending. */
    interruptible: Type.Boolean(),
    /** How long an unconsumed input stays eligible for this transition. */
    inputBufferMs: Type.Number({ minimum: 0, maximum: 1000 }),
    /**
     * Window in the SOURCE state's normalized time during which this transition
     * may fire. This is what makes combo cancels and late dodge-cancels work:
     * attack-01 -> attack-02 with {0.35, 0.75} is cancellable only mid-swing.
     */
    cancelWindow: Type.Optional(NormalizedWindow),
    priority: Type.Integer({ minimum: 0, maximum: 1000 }),
    /** Keyed by weapon mode id; applied over the base fields when that mode is active. */
    weaponOverrides: Type.Optional(Type.Record(Type.String(), TransitionWeaponOverride)),
    rootMotionMode: Type.Optional(RootMotionMode),
    protection: Type.Optional(ProtectionMetadata),
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'TransitionDefinition', additionalProperties: false },
);
export type TransitionDefinition = Static<typeof TransitionDefinition>;

/**
 * What happens when a state's clip reaches its end.
 *
 * This replaces `stateId.startsWith('attack-')` in the graph runtime. The old
 * rule was real behaviour — an attack falls through one tick late so its final
 * frame is rendered rather than swallowed — but it was keyed on a name, which
 * meant a new character could only get it by choosing the right spelling.
 */
export const StateCompletionPolicy = Type.Object(
  {
    mode: Type.Union([
      Type.Literal('loop'),
      Type.Literal('immediate-fallback'),
      Type.Literal('hold-final-frame'),
      Type.Literal('wait-for-transition'),
    ]),
    /** Extra ticks to hold on the final frame. 0 is the one-tick default. */
    holdTicks: Type.Integer({ minimum: 0, maximum: 240 }),
  },
  { $id: 'StateCompletionPolicy', additionalProperties: false },
);
export type StateCompletionPolicy = Static<typeof StateCompletionPolicy>;

/**
 * When an action hands the root back to locomotion. Replaces the
 * `endsWith('-recovery')` branch: a dedicated recovery clip returns authority
 * from its first frame, a dodge returns it near the end, and now both say so.
 */
export const StateRecoveryPolicy = Type.Object(
  {
    authorityReturnAtNormalized: NormalizedTime,
    blendDurationSec: Type.Number({ minimum: 0, maximum: 2 }),
  },
  { $id: 'StateRecoveryPolicy', additionalProperties: false },
);
export type StateRecoveryPolicy = Static<typeof StateRecoveryPolicy>;

/**
 * Who is allowed to move the character while this state is active.
 *
 * Three separate name checks used to live in the simulation — `startsWith
 * ('attack-')`, `=== 'dodge'`, `=== 'walk' || === 'run'`. They are three
 * different questions, so they are three fields rather than one enum.
 */
export const MovementAuthorityPolicy = Type.Object(
  {
    /** Action layer: pins the character until its recovery window opens. */
    locksMovementUntilRecovery: Type.Boolean(),
    /** Action layer: blends movement authority back over the recovery ramp. */
    returnsAuthorityOnRecovery: Type.Boolean(),
    /** Locomotion layer: counts as active ground locomotion to receive it. */
    providesLocomotionAuthority: Type.Boolean(),
    /**
     * Which authored speed this state's clip was made at, so playback can be
     * scaled to the speed actually reached and the feet stop skating.
     */
    locomotionSpeedReference: Type.Union([
      Type.Literal('none'),
      Type.Literal('walk'),
      Type.Literal('run'),
    ]),
  },
  { $id: 'MovementAuthorityPolicy', additionalProperties: false },
);
export type MovementAuthorityPolicy = Static<typeof MovementAuthorityPolicy>;

export const StateDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    /**
     * Logical motion this state plays, e.g. `action.primary.01`. The state
     * machine never names a clip: the character's motion set binds the slot.
     * That is the whole reason two characters can share one behaviour.
     */
    motionSlot: Type.String({ minLength: 1, maxLength: 128 }),
    /**
     * Slot to use instead, keyed by context (the weapon mode in the demo).
     * Most contextual motion is expressed as a contextual *binding* inside the
     * motion set — same slot, different clip. This is for the rarer case where
     * a context should play a structurally different slot altogether.
     */
    contextualMotionSlots: Type.Optional(Type.Record(Type.String(), Type.String())),
    layer: Type.String({ minLength: 1, maxLength: 64 }),
    loop: Type.Boolean(),
    speed: Type.Number({ minimum: 0.05, maximum: 4 }),
    /** Seconds after which the state force-exits. 0 disables. */
    timeoutSec: Type.Number({ minimum: 0, maximum: 60 }),
    /** State entered when the clip finishes and no transition matched. */
    fallbackState: Type.Optional(Id),
    completionPolicy: StateCompletionPolicy,
    recoveryPolicy: Type.Optional(StateRecoveryPolicy),
    movementAuthorityPolicy: MovementAuthorityPolicy,
    /** May a transition re-enter this state from itself. */
    allowReEntry: Type.Boolean(),
    interruptible: Type.Boolean(),
    /** Reserved upper/lower body mask structure (PLAN 7.1). */
    bodyMask: Type.Optional(
      Type.Union([Type.Literal('full'), Type.Literal('upper'), Type.Literal('lower')]),
    ),
    protection: Type.Optional(ProtectionMetadata),
    /**
     * Staging a value attaches provenance to the object that owns it, so every
     * type with an editable field needs somewhere to put it. `speed` is the
     * state's, which makes this as necessary here as it is on clips.
     */
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'StateDefinition', additionalProperties: false },
);
export type StateDefinition = Static<typeof StateDefinition>;

export const LayerDefinition = Type.Object(
  {
    /**
     * A string, not a two-member union. The MVP still ships exactly the
     * locomotion and action layers, but a behaviour asset that wanted a third
     * would otherwise have to change this package to get it.
     */
    id: Type.String({ minLength: 1, maxLength: 64 }),
    /** Higher index composites on top. */
    order: Type.Integer({ minimum: 0, maximum: 8 }),
    defaultState: Id,
    /** Weight of this layer when a non-default state is active. */
    weight: Type.Number({ minimum: 0, maximum: 1 }),
    bodyMask: Type.Union([Type.Literal('full'), Type.Literal('upper'), Type.Literal('lower')]),
  },
  { $id: 'LayerDefinition', additionalProperties: false },
);
export type LayerDefinition = Static<typeof LayerDefinition>;

export const AnimationGraphDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    layers: Type.Array(LayerDefinition, { minItems: 1 }),
    states: Type.Array(StateDefinition, { minItems: 1 }),
    transitions: Type.Array(TransitionDefinition),
    /**
     * Forced-transition ordering (PLAN 7.1). Earlier entries win. Death is
     * reserved even though the MVP has no death state.
     */
    forcedTransitionOrder: Type.Array(Type.String(), { minItems: 1 }),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'AnimationGraphDefinition', additionalProperties: false },
);
export type AnimationGraphDefinition = Static<typeof AnimationGraphDefinition>;

export { CurveKind };
