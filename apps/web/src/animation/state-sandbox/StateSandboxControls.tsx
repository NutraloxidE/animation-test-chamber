/**
 * Bootstrap, intent and display for the sandbox runtime.
 *
 * Bootstrap is deliberately a *starting position* rather than a running
 * override: choosing a state rebuilds the simulation from tick zero. There is
 * no control here that changes the state of a sandbox already in motion,
 * because that is the very thing the construction-only seam exists to make
 * unrepresentable — and a UI that offered it would be describing an operation
 * the runtime refuses.
 */
import { BUTTON_ACTIONS, type ButtonAction } from '@atc/schema';
import { useChamber } from '../../store.ts';
import type { ResolvedAnimationTarget } from '../target/resolve-animation-target.ts';
import { layersOf, statesOnLayer } from '../target/resolve-animation-target.ts';
import { intentPresetsFor } from './animation-sandbox-state.ts';

export function StateSandboxControls({ target }: { target: ResolvedAnimationTarget }) {
  const sandbox = useChamber((state) => state.sandbox);
  const setBootstrap = useChamber((state) => state.setSandboxBootstrap);
  const setNormalizedTime = useChamber((state) => state.setSandboxNormalizedTime);
  const setPlaying = useChamber((state) => state.setSandboxPlaying);
  const setSpeed = useChamber((state) => state.setSandboxSpeed);
  const setDisplayMode = useChamber((state) => state.setSandboxDisplayMode);
  const setIntentPreset = useChamber((state) => state.setSandboxIntentPreset);
  const toggleHold = useChamber((state) => state.toggleSandboxHold);
  const pulse = useChamber((state) => state.pulseSandboxAction);
  const reset = useChamber((state) => state.resetSandbox);
  const step = useChamber((state) => state.stepSandbox);
  const running = useChamber((state) => state.sandboxEngine !== null);

  const layers = layersOf(target);
  const presets = intentPresetsFor(BUTTON_ACTIONS);

  return (
    <div className="sandbox-controls" data-testid="sandbox-controls">
      <div className="workspace__row">
        <label>
          Bootstrap layer
          <select
            value={sandbox.bootstrapLayer}
            data-testid="sandbox-layer"
            onChange={(event) =>
              setBootstrap(event.target.value as 'locomotion' | 'action', null)
            }
          >
            {layers.map((layer) => (
              <option key={layer} value={layer}>
                {layer}
              </option>
            ))}
          </select>
        </label>
        <label>
          Bootstrap state
          <select
            value={sandbox.bootstrapStateId ?? ''}
            data-testid="sandbox-state"
            onChange={(event) => setBootstrap(sandbox.bootstrapLayer, event.target.value || null)}
          >
            <option value="">Default state</option>
            {/* This target's behaviour, resolved from its Character Definition.
                A state from another character's graph would be rejected by the
                bootstrap seam, and offering it would be inviting the error. */}
            {statesOnLayer(target, sandbox.bootstrapLayer).map((state) => (
              <option key={state.id} value={state.id}>
                {state.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Start at
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={sandbox.bootstrapNormalizedTime}
            data-testid="sandbox-start-normalized"
            onChange={(event) => setNormalizedTime(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="workspace__row">
        <button
          type="button"
          data-testid="sandbox-play"
          disabled={!running}
          onClick={() => setPlaying(true)}
        >
          Play
        </button>
        <button
          type="button"
          data-testid="sandbox-pause"
          disabled={!running}
          onClick={() => setPlaying(false)}
        >
          Pause
        </button>
        <button
          type="button"
          data-testid="sandbox-step"
          disabled={!running}
          onClick={() => {
            setPlaying(false);
            step(1);
          }}
        >
          Step tick
        </button>
        <button type="button" data-testid="sandbox-reset" onClick={() => reset()}>
          Reset to tick 0
        </button>
        <label>
          Speed
          <input
            type="number"
            min={0}
            max={4}
            step={0.1}
            value={sandbox.speed}
            data-testid="sandbox-speed"
            onChange={(event) => setSpeed(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="workspace__row">
        <label>
          Intent preset
          <select
            value={sandbox.intentPresetId}
            data-testid="sandbox-intent-preset"
            onChange={(event) => setIntentPreset(event.target.value)}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Display
          <select
            value={sandbox.displayMode}
            data-testid="sandbox-display-mode"
            onChange={(event) =>
              setDisplayMode(event.target.value as 'target-transform' | 'local-origin')
            }
          >
            <option value="local-origin">At Local Origin</option>
            <option value="target-transform">At Target Transform</option>
          </select>
        </label>
      </div>

      <div className="workspace__row sandbox-controls__buttons">
        {/* Declared by the Input Map, not by this file. The labels are as
            demo-specific as the project's own action names; the set is not
            hard-coded here. */}
        {BUTTON_ACTIONS.map((button: ButtonAction) => (
          <span key={button} className="sandbox-controls__button">
            <button
              type="button"
              data-testid={`sandbox-pulse-${button}`}
              disabled={!running}
              onClick={() => pulse(button)}
            >
              {button} pulse
            </button>
            <label>
              hold
              <input
                type="checkbox"
                checked={sandbox.heldButtons.includes(button)}
                data-testid={`sandbox-hold-${button}`}
                onChange={() => toggleHold(button)}
              />
            </label>
          </span>
        ))}
      </div>
    </div>
  );
}
