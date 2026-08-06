import { resolveBinding } from '@atc/haptics-runtime';
import { useChamber } from './chamber-source.ts';
import { Field } from './Field.tsx';

/**
 * Capability panel (PLAN 12.4). Only detected features are claimed — a
 * controller's name never implies what it can do — and every binding shows the
 * tier it will actually be played at on this device.
 */
export function CapabilityPanel() {
  const capability = useChamber((state) => state.capability);
  const project = useChamber((state) => state.project);
  const engine = useChamber((state) => state.engine);
  useChamber((state) => state.revision);

  const rows: { label: string; value: string; ok: boolean }[] = [
    { label: 'Input', value: capability.hasInput ? 'detected' : 'none', ok: capability.hasInput },
    {
      label: 'Generic Rumble',
      value: capability.hasGenericRumble ? 'available' : 'not available',
      ok: capability.hasGenericRumble,
    },
    {
      label: 'Trigger Rumble',
      value: capability.hasTriggerRumble ? 'available' : 'not available',
      ok: capability.hasTriggerRumble,
    },
    {
      label: 'Advanced Haptics',
      value: capability.hasAdvancedHaptics ? 'available' : 'no backend registered',
      ok: capability.hasAdvancedHaptics,
    },
    {
      label: 'Adaptive Triggers',
      value: capability.hasAdaptiveTriggers ? 'available' : 'no backend registered',
      ok: capability.hasAdaptiveTriggers,
    },
    { label: 'Permission State', value: capability.permissionState, ok: capability.permissionState === 'granted' },
    { label: 'Connection Type', value: capability.connectionType, ok: true },
  ];

  return (
    <div className="panel" data-testid="capability-panel">
      <header className="panel__header">
        <h2>Capability</h2>
        <span className="muted">{capability.deviceLabel}</span>
      </header>

      <table className="capability">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className={row.ok ? 'ok' : 'off'}>{row.value}</td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>Effective tier</strong>
            </td>
            <td>
              <strong>{capability.effectiveTier}</strong>
            </td>
          </tr>
        </tbody>
      </table>

      {capability.effectiveTier === 'none' && (
        <p className="muted">
          No haptic output on this device. Effects resolve to a no-op — the preview and the game keep
          running, nothing is blocked.
        </p>
      )}

      <Field
        path="/haptics/masterIntensity"
        label="Master intensity"
        min={0}
        max={1}
        step={0.01}
      />

      <h3>Bindings</h3>
      <ul className="binding-list">
        {project.haptics.bindings.map((binding) => {
          const resolved = resolveBinding(binding, capability, project.haptics.masterIntensity);
          return (
            <li key={binding.id}>
              <div className="binding-head">
                <code>{binding.event}</code>
                <button
                  type="button"
                  onClick={() => {
                    engine.refreshHapticCapability();
                    void engine.hapticPlayer.play(resolved);
                  }}
                >
                  test
                </button>
              </div>
              <span className="muted small">
                requires {binding.requiresTier} → plays at {resolved.playedAtTier}
                {resolved.degraded && ' (degraded)'} · {resolved.note}
              </span>
              <Field
                path={`/haptics/bindings/${binding.id}/lowFrequencyMagnitude`}
                label="Low frequency"
                min={0}
                max={1}
                step={0.01}
              />
              <Field
                path={`/haptics/bindings/${binding.id}/highFrequencyMagnitude`}
                label="High frequency"
                min={0}
                max={1}
                step={0.01}
              />
              <Field
                path={`/haptics/bindings/${binding.id}/durationMs`}
                label="Duration"
                min={1}
                max={600}
                step={1}
                format={(value) => `${value.toFixed(0)} ms`}
              />
              <Field
                path={`/haptics/bindings/${binding.id}/startDelayMs`}
                label="Start delay"
                min={0}
                max={400}
                step={1}
                format={(value) => `${value.toFixed(0)} ms`}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
