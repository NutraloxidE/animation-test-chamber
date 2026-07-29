import type {
  CapabilityProfile,
  HapticEventBinding,
  HapticProfile,
  HapticTier,
  SemanticEventKind,
} from '@atc/schema';
import { clamp01, evaluateCurve } from '@atc/runtime-core';
import { getExperimentalBackend } from './capability.ts';

const TIER_RANK: Record<HapticTier, number> = {
  none: 0,
  'generic-rumble': 1,
  'trigger-rumble': 2,
  advanced: 3,
};

/** What a binding will actually do on the current device, after degradation. */
export interface ResolvedHaptic {
  bindingId: string;
  /** Tier the effect will be played at; never above the device's tier. */
  playedAtTier: HapticTier;
  requestedTier: HapticTier;
  degraded: boolean;
  lowFrequencyMagnitude: number;
  highFrequencyMagnitude: number;
  leftTriggerMagnitude: number;
  rightTriggerMagnitude: number;
  durationMs: number;
  startDelayMs: number;
  /** Human-readable note shown in the capability panel when degraded. */
  note: string;
}

/**
 * Degrades a binding to what the device supports (PLAN 12.2):
 *   advanced -> trigger rumble -> generic rumble -> no-op
 * Playback never throws and never blocks the preview on an unsupported device.
 */
export function resolveBinding(
  binding: HapticEventBinding,
  capability: CapabilityProfile,
  masterIntensity: number,
): ResolvedHaptic {
  const deviceTier = capability.effectiveTier;
  const requested = binding.requiresTier;
  const playedAtTier: HapticTier =
    TIER_RANK[deviceTier] < TIER_RANK[requested] ? deviceTier : requested;
  const degraded = TIER_RANK[playedAtTier] < TIER_RANK[requested];

  const scale = clamp01(masterIntensity);
  const low = clamp01(binding.lowFrequencyMagnitude * scale);
  const high = clamp01(binding.highFrequencyMagnitude * scale);

  // Trigger energy folds into the main rumble when triggers are unavailable, so
  // the hit still registers instead of silently vanishing.
  const triggerFallback =
    playedAtTier === 'generic-rumble' && TIER_RANK[requested] >= TIER_RANK['trigger-rumble'];
  const foldedLow = triggerFallback
    ? clamp01(low + (binding.leftTriggerMagnitude + binding.rightTriggerMagnitude) * 0.25 * scale)
    : low;

  const notes: Record<HapticTier, string> = {
    none: 'no haptic output available; effect is a no-op',
    'generic-rumble': triggerFallback
      ? 'trigger energy folded into dual rumble'
      : 'played as dual rumble',
    'trigger-rumble': 'played with trigger rumble',
    advanced: 'played through the experimental advanced backend',
  };

  return {
    bindingId: binding.id,
    playedAtTier,
    requestedTier: requested,
    degraded,
    lowFrequencyMagnitude: playedAtTier === 'none' ? 0 : foldedLow,
    highFrequencyMagnitude: playedAtTier === 'none' ? 0 : high,
    leftTriggerMagnitude:
      TIER_RANK[playedAtTier] >= TIER_RANK['trigger-rumble']
        ? clamp01(binding.leftTriggerMagnitude * scale)
        : 0,
    rightTriggerMagnitude:
      TIER_RANK[playedAtTier] >= TIER_RANK['trigger-rumble']
        ? clamp01(binding.rightTriggerMagnitude * scale)
        : 0,
    durationMs: binding.durationMs,
    startDelayMs: binding.startDelayMs,
    note: notes[playedAtTier],
  };
}

interface ActuatorLike {
  playEffect?: (type: string, params: unknown) => Promise<string>;
  pulse?: (value: number, duration: number) => Promise<boolean>;
}

interface PadLike {
  id: string;
  vibrationActuator?: ActuatorLike;
}

/**
 * Plays semantic-event-driven haptics. Bindings live on their own track and are
 * looked up by event kind, so haptics are never baked into an animation clip.
 */
export class HapticPlayer {
  private capability: CapabilityProfile;
  private lastResolved: ResolvedHaptic[] = [];

  constructor(
    private profile: HapticProfile,
    capability: CapabilityProfile,
    private padProvider: () => PadLike | null = () => null,
  ) {
    this.capability = capability;
  }

  setProfile(profile: HapticProfile): void {
    this.profile = profile;
  }

  setCapability(capability: CapabilityProfile): void {
    this.capability = capability;
  }

  /** Last effects that were resolved, for display in the capability panel. */
  get recentlyResolved(): ResolvedHaptic[] {
    return this.lastResolved;
  }

  bindingsFor(event: SemanticEventKind): HapticEventBinding[] {
    return this.profile.bindings.filter((binding) => binding.event === event);
  }

  /** Fires every binding attached to a semantic event. Safe on any device. */
  trigger(event: SemanticEventKind): ResolvedHaptic[] {
    const resolved = this.bindingsFor(event).map((binding) =>
      resolveBinding(binding, this.capability, this.profile.masterIntensity),
    );
    this.lastResolved = resolved;
    for (const effect of resolved) {
      void this.play(effect);
    }
    return resolved;
  }

  /** Direct playback used by the "test" button in the capability panel. */
  async play(effect: ResolvedHaptic): Promise<void> {
    if (effect.playedAtTier === 'none') return;

    if (effect.playedAtTier === 'advanced') {
      const backend = getExperimentalBackend();
      const pad = this.padProvider();
      if (backend && pad) {
        try {
          await backend.playAdvanced(pad.id, {
            low: effect.lowFrequencyMagnitude,
            high: effect.highFrequencyMagnitude,
            durationMs: effect.durationMs,
          });
          return;
        } catch {
          // Fall through to standard rumble rather than dropping the effect.
        }
      }
    }

    const pad = this.padProvider();
    const actuator = pad?.vibrationActuator;
    if (!actuator) return;

    try {
      if (typeof actuator.playEffect === 'function') {
        await actuator.playEffect('dual-rumble', {
          startDelay: effect.startDelayMs,
          duration: effect.durationMs,
          weakMagnitude: effect.highFrequencyMagnitude,
          strongMagnitude: effect.lowFrequencyMagnitude,
        });
      } else if (typeof actuator.pulse === 'function') {
        await actuator.pulse(effect.lowFrequencyMagnitude, effect.durationMs);
      }
    } catch {
      // A rejected vibration request must never interrupt the preview.
    }
  }

  /**
   * Envelope value at `elapsedMs` into the effect. Used by the timeline to draw
   * the haptic track and by tests to assert curve shaping.
   */
  static envelopeAt(binding: HapticEventBinding, elapsedMs: number): number {
    if (elapsedMs < binding.startDelayMs) return 0;
    const local = elapsedMs - binding.startDelayMs;
    if (local > binding.durationMs) return 0;
    const t = binding.durationMs <= 0 ? 1 : local / binding.durationMs;
    // Curves describe attack shape; the effect always decays to zero at the end.
    return evaluateCurve(binding.curve, 1 - t);
  }
}
