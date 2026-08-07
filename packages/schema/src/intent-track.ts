/**
 * Deterministic authored intent tracks.
 *
 * Extracted from `world.ts` unchanged. A track is not a World concept and never
 * was — it is a scripted `CharacterIntentSource` written down as data — so it
 * outlives the World-to-Scene migration in place rather than being renamed
 * along with it. Keeping it here is what lets `scene.ts` and the legacy World
 * contract reference one definition instead of drifting into two.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Id, ProtectionMetadata, SchemaVersion } from './common.ts';
import { BUTTON_ACTIONS } from './input.ts';

const ButtonMap = Type.Object(
  Object.fromEntries(BUTTON_ACTIONS.map((action) => [action, Type.Optional(Type.Boolean())])),
  { additionalProperties: false },
);

/**
 * One authored point on an intent track.
 *
 * Keyed by simulation tick, never by milliseconds: a track sampled from
 * wall-clock time would produce different intent on a 30Hz laptop and a 144Hz
 * desktop, and the whole reason this type exists is that it must not.
 */
export const IntentTrackKeyframe = Type.Object(
  {
    tick: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
    move: Type.Optional(
      Type.Object(
        { x: Type.Number({ minimum: -1, maximum: 1 }), y: Type.Number({ minimum: -1, maximum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    look: Type.Optional(
      Type.Object(
        { x: Type.Number({ minimum: -1, maximum: 1 }), y: Type.Number({ minimum: -1, maximum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    buttons: Type.Optional(ButtonMap),
  },
  { $id: 'IntentTrackKeyframe', additionalProperties: false },
);
export type IntentTrackKeyframe = Static<typeof IntentTrackKeyframe>;

/**
 * A deterministic authored intent track.
 *
 * Sampling holds the last keyframe's values until the next one (DECISION 0009):
 * step semantics, not interpolation. Interpolating analog sticks would be
 * defensible; interpolating a button press is not, and a track where the two
 * halves obeyed different rules would be a track nobody could read. Holding is
 * the rule that is the same for every field.
 */
export const IntentTrackDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    displayName: Type.String(),
    loop: Type.Boolean(),
    durationTicks: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
    keyframes: Type.Array(IntentTrackKeyframe, { minItems: 1 }),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'IntentTrackDefinition', additionalProperties: false },
);
export type IntentTrackDefinition = Static<typeof IntentTrackDefinition>;
