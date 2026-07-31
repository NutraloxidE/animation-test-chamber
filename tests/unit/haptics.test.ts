import { describe, expect, it } from 'vitest';
import type { CapabilityProfile, HapticEventBinding } from '@atc/schema';
import {
  HapticPlayer,
  detectCapability,
  registerExperimentalBackend,
  resolveBinding,
  unavailableCapability,
} from '@atc/haptics-runtime';
import { loadResolvedDemoProject } from '../fixtures/project.ts';

const project = loadResolvedDemoProject();

function capabilityAt(tier: CapabilityProfile['effectiveTier']): CapabilityProfile {
  return {
    schemaVersion: 1,
    deviceLabel: 'test-pad',
    connectionType: 'unknown',
    hasInput: true,
    hasGenericRumble: tier !== 'none',
    hasTriggerRumble: tier === 'trigger-rumble' || tier === 'advanced',
    hasAdvancedHaptics: tier === 'advanced',
    hasAdaptiveTriggers: tier === 'advanced',
    permissionState: 'granted',
    effectiveTier: tier,
  };
}

const dodgeBinding = project.haptics.bindings.find((b) => b.id === 'haptic-dodge')!;
const hitBinding = project.haptics.bindings.find((b) => b.id === 'haptic-attack-hit')!;

describe('capability detection', () => {
  it('claims nothing when there is no controller', () => {
    const capability = detectCapability(null);
    expect(capability.effectiveTier).toBe('none');
    expect(capability.hasInput).toBe(false);
    expect(capability.permissionState).toBe('unavailable');
  });

  it('never infers capability from the controller name alone', () => {
    // A device whose id claims to be a DualSense but exposes no actuator.
    const capability = detectCapability({
      id: 'Sony DualSense Wireless Controller',
      connected: true,
    });
    expect(capability.hasGenericRumble).toBe(false);
    expect(capability.hasAdvancedHaptics).toBe(false);
    expect(capability.effectiveTier).toBe('none');
  });

  it('detects generic rumble from the actuator, not the name', () => {
    const capability = detectCapability({
      id: 'Unknown Gamepad (STANDARD GAMEPAD)',
      connected: true,
      vibrationActuator: { playEffect: async () => 'complete' },
    });
    expect(capability.hasGenericRumble).toBe(true);
    expect(capability.effectiveTier).toBe('generic-rumble');
  });

  it('detects trigger rumble when the extra actuators are present', () => {
    const capability = detectCapability({
      id: 'pad',
      connected: true,
      vibrationActuator: { playEffect: async () => 'complete' },
      hapticActuators: [{ type: 'trigger-rumble' }],
    });
    expect(capability.effectiveTier).toBe('trigger-rumble');
  });

  it('reports advanced haptics only when an experimental backend registers', () => {
    const pad = {
      id: 'pad',
      connected: true,
      vibrationActuator: { playEffect: async () => 'complete' },
    };
    expect(detectCapability(pad).hasAdvancedHaptics).toBe(false);

    registerExperimentalBackend({
      isAvailable: () => true,
      supportsAdaptiveTriggers: () => true,
      playAdvanced: async () => {},
      setAdaptiveTrigger: async () => {},
    });
    expect(detectCapability(pad).effectiveTier).toBe('advanced');

    registerExperimentalBackend(null);
    expect(detectCapability(pad).hasAdvancedHaptics).toBe(false);
  });
});

describe('tier fallback', () => {
  it('plays at the requested tier when the device supports it', () => {
    const resolved = resolveBinding(dodgeBinding, capabilityAt('trigger-rumble'), 1);
    expect(resolved.playedAtTier).toBe('trigger-rumble');
    expect(resolved.degraded).toBe(false);
    expect(resolved.leftTriggerMagnitude).toBeGreaterThan(0);
  });

  it('degrades trigger rumble to generic rumble rather than dropping it', () => {
    const resolved = resolveBinding(dodgeBinding, capabilityAt('generic-rumble'), 1);
    expect(resolved.playedAtTier).toBe('generic-rumble');
    expect(resolved.degraded).toBe(true);
    expect(resolved.leftTriggerMagnitude).toBe(0);
    // Trigger energy is folded into the main rumble so the beat is still felt.
    expect(resolved.lowFrequencyMagnitude).toBeGreaterThan(dodgeBinding.lowFrequencyMagnitude);
  });

  it('becomes a silent no-op with no device, without throwing', () => {
    const resolved = resolveBinding(hitBinding, unavailableCapability(), 1);
    expect(resolved.playedAtTier).toBe('none');
    expect(resolved.lowFrequencyMagnitude).toBe(0);
    expect(resolved.highFrequencyMagnitude).toBe(0);
  });

  it('never exceeds the device tier even when the binding asks for more', () => {
    const advanced: HapticEventBinding = { ...hitBinding, requiresTier: 'advanced' };
    const resolved = resolveBinding(advanced, capabilityAt('generic-rumble'), 1);
    expect(resolved.playedAtTier).toBe('generic-rumble');
  });

  it('scales every magnitude by the master intensity', () => {
    const full = resolveBinding(hitBinding, capabilityAt('generic-rumble'), 1);
    const half = resolveBinding(hitBinding, capabilityAt('generic-rumble'), 0.5);
    expect(half.lowFrequencyMagnitude).toBeCloseTo(full.lowFrequencyMagnitude * 0.5, 5);
  });
});

describe('playback safety', () => {
  it('resolves rather than throwing when the actuator rejects', async () => {
    const player = new HapticPlayer(project.haptics, capabilityAt('generic-rumble'), () => ({
      id: 'pad',
      vibrationActuator: {
        playEffect: async () => {
          throw new Error('permission denied');
        },
      },
    }));
    const resolved = player.trigger('AttackHit');
    expect(resolved.length).toBeGreaterThan(0);
    await expect(player.play(resolved[0]!)).resolves.toBeUndefined();
  });

  it('triggers only the bindings attached to that semantic event', () => {
    const player = new HapticPlayer(project.haptics, capabilityAt('generic-rumble'));
    expect(player.trigger('AttackHit').map((r) => r.bindingId)).toEqual(['haptic-attack-hit']);
    expect(player.trigger('GuardImpact')).toEqual([]);
  });

  it('shapes the envelope so the effect decays to zero', () => {
    expect(HapticPlayer.envelopeAt(hitBinding, 0)).toBeGreaterThan(0);
    expect(HapticPlayer.envelopeAt(hitBinding, hitBinding.durationMs)).toBe(0);
    expect(HapticPlayer.envelopeAt(hitBinding, hitBinding.durationMs + 50)).toBe(0);
  });
});
