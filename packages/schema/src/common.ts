import { Type, type Static } from '@sinclair/typebox';

/**
 * Protection levels. This is the mechanism described in PLAN 1.3: values a human
 * has confirmed must survive later AI edits.
 *
 * editable          - normal change allowed
 * approval-required - AI may propose, but nothing is applied without human approval
 * locked            - no change until a human unlocks it
 * invariant         - project-wide condition, never relaxed by tooling
 */
export const ProtectionLevel = Type.Union(
  [
    Type.Literal('editable'),
    Type.Literal('approval-required'),
    Type.Literal('locked'),
    Type.Literal('invariant'),
  ],
  { $id: 'ProtectionLevel' },
);
export type ProtectionLevel = Static<typeof ProtectionLevel>;

export const ProtectionMetadata = Type.Object(
  {
    level: ProtectionLevel,
    reason: Type.Optional(Type.String()),
    /** Who established this protection. */
    setBy: Type.Optional(Type.String()),
    setAt: Type.Optional(Type.String()),
    /** Field paths inside this object that carry a stricter level than the object. */
    fields: Type.Optional(Type.Record(Type.String(), ProtectionLevel)),
  },
  { $id: 'ProtectionMetadata', additionalProperties: false },
);
export type ProtectionMetadata = Static<typeof ProtectionMetadata>;

/** Where a value came from. Human decisions are never anonymous. */
export const ValueProvenance = Type.Object(
  {
    source: Type.Union([
      Type.Literal('repository'),
      Type.Literal('human-adjustment'),
      Type.Literal('ai-proposal'),
      Type.Literal('import'),
      Type.Literal('default'),
    ]),
    basedOnAiProposal: Type.Optional(Type.Number()),
    humanFinal: Type.Optional(Type.Number()),
    replayId: Type.Optional(Type.String()),
    terrainPresetId: Type.Optional(Type.String()),
    intent: Type.Optional(Type.String()),
    at: Type.Optional(Type.String()),
  },
  { $id: 'ValueProvenance', additionalProperties: false },
);
export type ValueProvenance = Static<typeof ValueProvenance>;

export const Vec3 = Type.Object(
  { x: Type.Number(), y: Type.Number(), z: Type.Number() },
  { $id: 'Vec3', additionalProperties: false },
);
export type Vec3 = Static<typeof Vec3>;

/** Stable identifier: lowercase, digits, dash. Used in canonical paths. */
export const Id = Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$', minLength: 1, maxLength: 96 });

export const SchemaVersion = Type.Integer({ minimum: 1 });

/** Normalized clip time, [0..1]. PLAN 3.3. */
export const NormalizedTime = Type.Number({ minimum: 0, maximum: 1 });

export const NormalizedWindow = Type.Object(
  { start: NormalizedTime, end: NormalizedTime },
  { $id: 'NormalizedWindow', additionalProperties: false },
);
export type NormalizedWindow = Static<typeof NormalizedWindow>;

/** Interpolation curve applied to blends and haptic envelopes. */
export const CurveKind = Type.Union(
  [
    Type.Literal('linear'),
    Type.Literal('ease-in'),
    Type.Literal('ease-out'),
    Type.Literal('ease-in-out'),
    Type.Literal('step'),
  ],
  { $id: 'CurveKind' },
);
export type CurveKind = Static<typeof CurveKind>;
