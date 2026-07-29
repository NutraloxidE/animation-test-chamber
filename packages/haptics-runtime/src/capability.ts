import type { CapabilityProfile, HapticTier } from '@atc/schema';

/**
 * Minimal structural view of the Gamepad haptics surface. Browsers disagree on
 * what exists, so every field is optional and probed at runtime — a controller's
 * product name is never used to infer capability (PLAN 12.4).
 */
interface HapticActuatorLike {
  type?: string;
  playEffect?: (type: string, params: unknown) => Promise<string>;
  pulse?: (value: number, duration: number) => Promise<boolean>;
  reset?: () => Promise<string>;
}

interface GamepadLike {
  id: string;
  connected: boolean;
  vibrationActuator?: HapticActuatorLike;
  hapticActuators?: HapticActuatorLike[];
}

export function unavailableCapability(): CapabilityProfile {
  return {
    schemaVersion: 1,
    deviceLabel: 'no controller',
    connectionType: 'unknown',
    hasInput: false,
    hasGenericRumble: false,
    hasTriggerRumble: false,
    hasAdvancedHaptics: false,
    hasAdaptiveTriggers: false,
    permissionState: 'unavailable',
    effectiveTier: 'none',
  };
}

function effectiveTierOf(profile: Omit<CapabilityProfile, 'effectiveTier'>): HapticTier {
  if (profile.hasAdvancedHaptics) return 'advanced';
  if (profile.hasTriggerRumble) return 'trigger-rumble';
  if (profile.hasGenericRumble) return 'generic-rumble';
  return 'none';
}

/**
 * Probes a connected gamepad for what it can actually do. Detection is
 * feature-based: we look for the actuator objects and their supported effect
 * types rather than matching product ids.
 */
export function detectCapability(pad: GamepadLike | null): CapabilityProfile {
  if (!pad || !pad.connected) return unavailableCapability();

  const vibration = pad.vibrationActuator;
  const actuators = pad.hapticActuators ?? [];

  const hasGenericRumble =
    typeof vibration?.playEffect === 'function' || typeof vibration?.pulse === 'function';

  // Trigger rumble is exposed either as extra actuators or as a distinct
  // effect type on the main actuator, depending on the browser.
  const triggerActuators = actuators.filter(
    (actuator) => actuator.type === 'trigger-rumble' || actuator.type === 'trigger',
  );
  const hasTriggerRumble =
    triggerActuators.length > 0 || vibration?.type === 'trigger-rumble';

  // Nothing standard exposes DualSense advanced haptics to the web today; the
  // adapter below is the seam where an experimental backend can register.
  const hasAdvancedHaptics = experimentalBackend?.isAvailable(pad.id) ?? false;
  const hasAdaptiveTriggers = experimentalBackend?.supportsAdaptiveTriggers(pad.id) ?? false;

  const partial = {
    schemaVersion: 1 as const,
    deviceLabel: pad.id,
    connectionType: connectionTypeOf(pad.id),
    hasInput: true,
    hasGenericRumble,
    hasTriggerRumble,
    hasAdvancedHaptics,
    hasAdaptiveTriggers,
    permissionState: hasGenericRumble ? ('granted' as const) : ('unavailable' as const),
  };

  return { ...partial, effectiveTier: effectiveTierOf(partial) };
}

function connectionTypeOf(id: string): CapabilityProfile['connectionType'] {
  // The Standard Gamepad id string is the only hint browsers give, and it does
  // not reliably carry transport information. Report unknown unless it does.
  const lower = id.toLowerCase();
  if (lower.includes('bluetooth')) return 'bluetooth';
  if (lower.includes('usb')) return 'usb';
  return 'unknown';
}

/**
 * Experimental adapter boundary for DualSense Extended (PLAN 12.2 Tier 3).
 * Nothing in the core depends on this being present; when no backend is
 * registered the capability probe simply reports the feature as absent.
 */
export interface ExperimentalHapticBackend {
  isAvailable(deviceId: string): boolean;
  supportsAdaptiveTriggers(deviceId: string): boolean;
  playAdvanced(deviceId: string, payload: Record<string, number>): Promise<void>;
  setAdaptiveTrigger(deviceId: string, payload: Record<string, number | string>): Promise<void>;
}

let experimentalBackend: ExperimentalHapticBackend | null = null;

export function registerExperimentalBackend(backend: ExperimentalHapticBackend | null): void {
  experimentalBackend = backend;
}

export function getExperimentalBackend(): ExperimentalHapticBackend | null {
  return experimentalBackend;
}

/** Reads the first connected gamepad, if the browser exposes any. */
export function readActiveGamepad(): GamepadLike | null {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
  for (const pad of navigator.getGamepads()) {
    if (pad && pad.connected) return pad as unknown as GamepadLike;
  }
  return null;
}
