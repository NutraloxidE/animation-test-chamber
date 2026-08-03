/**
 * What the sandbox is being told to do, and how it is being shown.
 *
 * Intent presets are built from the project's own Input Map rather than from a
 * hard-coded list of game actions: the schema declares which buttons exist, and
 * baking "Attack" and "Dodge" into a UI module here would put demo-specific
 * vocabulary one refactor away from the canonical data it is supposed to be
 * derived from. Labels are demo-shaped because the Input Map is; the *set* is
 * not.
 */
import type { ButtonAction } from '@atc/schema';
import { emptySample, type ActionSample } from '@atc/input-runtime';

export type SandboxDisplayMode = 'target-transform' | 'local-origin';

export interface StateSandboxUiState {
  bootstrapLayer: 'locomotion' | 'action';
  bootstrapStateId: string | null;
  bootstrapNormalizedTime: number;
  playing: boolean;
  speed: number;
  displayMode: SandboxDisplayMode;
  intentPresetId: string;
  /** Buttons the user is holding down, on top of the preset. */
  heldButtons: ButtonAction[];
  /** Buttons to press for exactly one tick, then clear. */
  pulseButtons: ButtonAction[];
}

export const NO_SANDBOX: StateSandboxUiState = {
  bootstrapLayer: 'action',
  bootstrapStateId: null,
  bootstrapNormalizedTime: 0,
  playing: false,
  speed: 1,
  displayMode: 'local-origin',
  intentPresetId: 'neutral',
  heldButtons: [],
  pulseButtons: [],
};

export interface IntentPreset {
  id: string;
  label: string;
  moveX: number;
  moveY: number;
  buttons: ButtonAction[];
}

/** Movement presets. Independent of which buttons a project declares. */
const MOVEMENT_PRESETS: IntentPreset[] = [
  { id: 'neutral', label: 'Neutral', moveX: 0, moveY: 0, buttons: [] },
  { id: 'forward', label: 'Move Forward', moveX: 0, moveY: 1, buttons: [] },
  { id: 'left', label: 'Move Left', moveX: -1, moveY: 0, buttons: [] },
  { id: 'right', label: 'Move Right', moveX: 1, moveY: 0, buttons: [] },
];

/**
 * Presets for one project's Input Map.
 *
 * A hold preset per declared button, plus the movement set. `Attack pulse` and
 * friends are the *pulse* controls rather than presets, because a preset is a
 * steady state and a pulse is an edge — folding them together is how a "hold
 * guard" preset ends up re-triggering a buffered press every tick.
 */
export function intentPresetsFor(buttons: readonly ButtonAction[]): IntentPreset[] {
  return [
    ...MOVEMENT_PRESETS,
    ...buttons.map((button) => ({
      id: `hold:${button}`,
      label: `Hold ${button}`,
      moveX: 0,
      moveY: 0,
      buttons: [button],
    })),
  ];
}

/** The intent for one tick: preset, plus held buttons, plus this tick's pulses. */
export function sampleFor(
  preset: IntentPreset | undefined,
  held: readonly ButtonAction[],
  pulses: readonly ButtonAction[],
): ActionSample {
  const sample = emptySample();
  if (preset) {
    sample.moveX = preset.moveX;
    sample.moveY = preset.moveY;
    for (const button of preset.buttons) sample.buttons[button] = true;
  }
  for (const button of held) sample.buttons[button] = true;
  for (const button of pulses) sample.buttons[button] = true;
  return sample;
}
