import { Type, type Static } from '@sinclair/typebox';
import { CurveKind, Id, ProtectionMetadata, SchemaVersion, ValueProvenance } from './common.ts';
import { SemanticEventKind } from './animation.ts';

/**
 * Capability tiers (PLAN 12.2). A tier is only claimed after runtime detection —
 * never inferred from a controller's product name.
 */
export const HapticTier = Type.Union(
  [
    Type.Literal('none'),
    Type.Literal('generic-rumble'),
    Type.Literal('trigger-rumble'),
    Type.Literal('advanced'),
  ],
  { $id: 'HapticTier' },
);
export type HapticTier = Static<typeof HapticTier>;

export const CapabilityProfile = Type.Object(
  {
    schemaVersion: SchemaVersion,
    /** Reported device id, recorded for diagnostics only. */
    deviceLabel: Type.String(),
    connectionType: Type.Union([
      Type.Literal('unknown'),
      Type.Literal('usb'),
      Type.Literal('bluetooth'),
    ]),
    hasInput: Type.Boolean(),
    hasGenericRumble: Type.Boolean(),
    hasTriggerRumble: Type.Boolean(),
    hasAdvancedHaptics: Type.Boolean(),
    hasAdaptiveTriggers: Type.Boolean(),
    permissionState: Type.Union([
      Type.Literal('granted'),
      Type.Literal('denied'),
      Type.Literal('prompt'),
      Type.Literal('unavailable'),
    ]),
    /** Highest tier actually usable right now. */
    effectiveTier: HapticTier,
  },
  { $id: 'CapabilityProfile', additionalProperties: false },
);
export type CapabilityProfile = Static<typeof CapabilityProfile>;

export const AdaptiveTriggerPreset = Type.Union(
  [
    Type.Literal('off'),
    Type.Literal('resistance'),
    Type.Literal('weapon'),
    Type.Literal('pulse'),
    Type.Literal('recoil'),
  ],
  { $id: 'AdaptiveTriggerPreset' },
);
export type AdaptiveTriggerPreset = Static<typeof AdaptiveTriggerPreset>;

/** One haptic response bound to a semantic event, never baked into a clip. */
export const HapticEventBinding = Type.Object(
  {
    id: Id,
    event: SemanticEventKind,
    /** Milliseconds after the semantic event fires. */
    startDelayMs: Type.Number({ minimum: 0, maximum: 2000 }),
    durationMs: Type.Number({ minimum: 1, maximum: 5000 }),
    lowFrequencyMagnitude: Type.Number({ minimum: 0, maximum: 1 }),
    highFrequencyMagnitude: Type.Number({ minimum: 0, maximum: 1 }),
    curve: CurveKind,
    leftTriggerMagnitude: Type.Number({ minimum: 0, maximum: 1 }),
    rightTriggerMagnitude: Type.Number({ minimum: 0, maximum: 1 }),
    adaptiveTriggerPreset: AdaptiveTriggerPreset,
    resistanceStart: Type.Number({ minimum: 0, maximum: 1 }),
    resistanceStrength: Type.Number({ minimum: 0, maximum: 1 }),
    breakPoint: Type.Number({ minimum: 0, maximum: 1 }),
    /** Minimum tier required; lower tiers degrade instead of dropping out. */
    requiresTier: HapticTier,
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'HapticEventBinding', additionalProperties: false },
);
export type HapticEventBinding = Static<typeof HapticEventBinding>;

export const HapticProfile = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    /** Global scale applied to every binding. */
    masterIntensity: Type.Number({ minimum: 0, maximum: 1 }),
    bindings: Type.Array(HapticEventBinding),
    protection: Type.Optional(ProtectionMetadata),
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'HapticProfile', additionalProperties: false },
);
export type HapticProfile = Static<typeof HapticProfile>;
