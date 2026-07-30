import { Type, type Static } from '@sinclair/typebox';
import { Id, ProtectionMetadata, SchemaVersion } from './common.ts';

/**
 * Physical devices are never wired to the state machine directly (PLAN 6).
 * Everything is converted into these actions first.
 */
export const ActionName = Type.Union(
  [
    Type.Literal('Move'),
    Type.Literal('Look'),
    Type.Literal('Jump'),
    Type.Literal('PrimaryAction'),
    Type.Literal('SecondaryAction'),
    Type.Literal('Dodge'),
    Type.Literal('Guard'),
    Type.Literal('LockOn'),
    Type.Literal('Interact'),
    Type.Literal('Pause'),
  ],
  { $id: 'ActionName' },
);
export type ActionName = Static<typeof ActionName>;

export const ACTION_NAMES = [
  'Move',
  'Look',
  'Jump',
  'PrimaryAction',
  'SecondaryAction',
  'Dodge',
  'Guard',
  'LockOn',
  'Interact',
  'Pause',
] as const;

/** Button actions, i.e. everything except the two analog actions. */
export const BUTTON_ACTIONS = [
  'Jump',
  'PrimaryAction',
  'SecondaryAction',
  'Dodge',
  'Guard',
  'LockOn',
  'Interact',
  'Pause',
] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

export const InputDeviceKind = Type.Union(
  [
    Type.Literal('keyboard'),
    Type.Literal('mouse'),
    Type.Literal('gamepad'),
    Type.Literal('touch'),
  ],
  { $id: 'InputDeviceKind' },
);
export type InputDeviceKind = Static<typeof InputDeviceKind>;

export const KeyboardBinding = Type.Object(
  {
    action: ActionName,
    /** KeyboardEvent.code values. */
    codes: Type.Array(Type.String(), { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const GamepadBinding = Type.Object(
  {
    action: ActionName,
    /** Standard Gamepad button indices. */
    buttons: Type.Array(Type.Integer({ minimum: 0, maximum: 17 })),
  },
  { additionalProperties: false },
);

export const MobilePadLayout = Type.Object(
  {
    /** auto shows the pad only when a touch device is detected. */
    visibility: Type.Union([
      Type.Literal('auto'),
      Type.Literal('always-on'),
      Type.Literal('always-off'),
    ]),
    stickMode: Type.Union([Type.Literal('fixed'), Type.Literal('floating')]),
    leftHanded: Type.Boolean(),
    buttonScale: Type.Number({ minimum: 0.5, maximum: 2 }),
    opacity: Type.Number({ minimum: 0.1, maximum: 1 }),
    /** Hides all touch UI for clean capture. */
    hideForRecording: Type.Boolean(),
  },
  { $id: 'MobilePadLayout', additionalProperties: false },
);
export type MobilePadLayout = Static<typeof MobilePadLayout>;

export const InputMapDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    id: Id,
    keyboard: Type.Array(KeyboardBinding),
    gamepad: Type.Array(GamepadBinding),
    /** Gamepad stick deadzone, applied radially. */
    stickDeadzone: Type.Number({ minimum: 0, maximum: 0.9 }),
    /** Seconds for the smoothed stick vector to close ~63% of the gap to the raw one. */
    stickSmoothingSec: Type.Optional(Type.Number({ minimum: 0, maximum: 0.5 })),
    lookSensitivity: Type.Number({ minimum: 0.05, maximum: 10 }),
    invertLookY: Type.Boolean(),
    mobilePad: MobilePadLayout,
    /** Global buffer applied when a transition does not set its own. */
    defaultInputBufferMs: Type.Number({ minimum: 0, maximum: 1000 }),
    coyoteTimeMs: Type.Number({ minimum: 0, maximum: 500 }),
    jumpBufferMs: Type.Number({ minimum: 0, maximum: 500 }),
    protection: Type.Optional(ProtectionMetadata),
  },
  { $id: 'InputMapDefinition', additionalProperties: false },
);
export type InputMapDefinition = Static<typeof InputMapDefinition>;
