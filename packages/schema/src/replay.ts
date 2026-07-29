import { Type, type Static } from '@sinclair/typebox';
import { Id, SchemaVersion, Vec3 } from './common.ts';
import { ACTION_NAMES } from './input.ts';

/**
 * A single simulation tick of input. Buttons are stored as a bitmask over
 * ACTION_NAMES so replay files stay small and diffable.
 */
export const ReplayFrame = Type.Object(
  {
    tick: Type.Integer({ minimum: 0 }),
    moveX: Type.Number({ minimum: -1, maximum: 1 }),
    moveY: Type.Number({ minimum: -1, maximum: 1 }),
    lookX: Type.Number({ minimum: -1, maximum: 1 }),
    lookY: Type.Number({ minimum: -1, maximum: 1 }),
    /** Bit i corresponds to ACTION_NAMES[i]. */
    buttons: Type.Integer({ minimum: 0 }),
  },
  { $id: 'ReplayFrame', additionalProperties: false },
);
export type ReplayFrame = Static<typeof ReplayFrame>;

export const ACTION_BIT = Object.fromEntries(
  ACTION_NAMES.map((name, index) => [name, 1 << index]),
) as Record<(typeof ACTION_NAMES)[number], number>;

export const ReplayDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    label: Type.String(),
    /** Project revision the replay was recorded against. */
    revisionId: Type.String(),
    /** Bumped whenever simulation semantics change; guards stale expectations. */
    fixedTimestepVersion: Type.Integer({ minimum: 1 }),
    seed: Type.Integer({ minimum: 0 }),
    terrainPresetId: Id,
    initialPosition: Vec3,
    initialYawRad: Type.Number(),
    /** Camera yaw is part of the input contract for camera-relative movement. */
    cameraYawRad: Type.Number(),
    tickCount: Type.Integer({ minimum: 1, maximum: 100000 }),
    frames: Type.Array(ReplayFrame),
  },
  { $id: 'ReplayDefinition', additionalProperties: false },
);
export type ReplayDefinition = Static<typeof ReplayDefinition>;

/** Tolerances used when comparing two traces (PLAN 13.3). */
export const ReplayTolerance = Type.Object(
  {
    positionMeters: Type.Number({ minimum: 0 }),
    eventTicks: Type.Integer({ minimum: 0 }),
    footSlidingMeters: Type.Number({ minimum: 0 }),
  },
  { $id: 'ReplayTolerance', additionalProperties: false },
);
export type ReplayTolerance = Static<typeof ReplayTolerance>;
