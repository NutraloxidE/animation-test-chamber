import { useState } from 'react';
import { compareTraces } from '@atc/replay-runtime';
import { useChamber } from '../store.ts';

/**
 * Replay controls and comparison (PLAN 8.5, 13). The point of this panel is that
 * every comparison runs the *same* input, terrain, seed and start state — the
 * only difference is the document being evaluated.
 */
export function ReplayPanel() {
  const engine = useChamber((state) => state.engine);
  const session = useChamber((state) => state.session);
  const replays = useChamber((state) => state.replays);
  const recorded = useChamber((state) => state.recordedReplays);
  const selectedReplayId = useChamber((state) => state.selectedReplayId);
  const selectReplay = useChamber((state) => state.selectReplay);
  const playSelectedReplay = useChamber((state) => state.playSelectedReplay);
  const addRecordedReplay = useChamber((state) => state.addRecordedReplay);
  const ghostEnabled = useChamber((state) => state.ghostEnabled);
  const setGhostEnabled = useChamber((state) => state.setGhostEnabled);
  const compareSlots = useChamber((state) => state.compareSlots);
  const activeCompareSlot = useChamber((state) => state.activeCompareSlot);
  const activateCompareSlot = useChamber((state) => state.activateCompareSlot);
  const buildCompareSlots = useChamber((state) => state.buildCompareSlots);
  useChamber((state) => state.revision);

  const [timeScale, setTimeScale] = useState(1);
  const [recording, setRecording] = useState(false);

  const all = [...replays, ...recorded];
  const replay = all.find((entry) => entry.id === selectedReplayId);

  const beforeTrace = replay ? engine.traceFor(session.repositoryProject, replay) : null;
  const afterTrace = replay ? engine.traceFor(session.previewProject, replay) : null;
  const comparison =
    beforeTrace && afterTrace ? compareTraces(beforeTrace, afterTrace) : null;

  return (
    <div className="panel" data-testid="replay-panel">
      <header className="panel__header">
        <h2>Replay &amp; Compare</h2>
      </header>

      <select
        className="wide"
        value={selectedReplayId}
        onChange={(event) => selectReplay(event.target.value)}
      >
        {all.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label} ({entry.terrainPresetId}, {entry.tickCount} ticks)
          </option>
        ))}
      </select>

      <div className="button-row">
        <button type="button" onClick={playSelectedReplay} data-testid="play-replay">
          Play replay
        </button>
        <button type="button" onClick={() => engine.stopReplay()}>
          Back to live
        </button>
        <button
          type="button"
          onClick={() => {
            if (recording) {
              const result = engine.stopRecording();
              if (result) addRecordedReplay(result);
              setRecording(false);
            } else {
              engine.startRecording(`recorded-${Date.now().toString(36)}`);
              setRecording(true);
            }
          }}
        >
          {recording ? 'Stop recording' : 'Record input'}
        </button>
      </div>

      <div className="button-row">
        <button type="button" onClick={() => engine.setPaused(!engine.isPaused)}>
          {engine.isPaused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" onClick={() => engine.frameStep()}>
          Frame step
        </button>
        <button type="button" onClick={() => engine.injectFrameDrop(8)}>
          Inject 8-tick hitch
        </button>
        <button type="button" onClick={() => engine.reset()}>
          Reset
        </button>
      </div>

      <label className="inline-field">
        Slow motion
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={timeScale}
          onChange={(event) => {
            const scale = Number(event.target.value);
            setTimeScale(scale);
            engine.setTimeScale(scale);
          }}
        />
        <span>{timeScale.toFixed(2)}×</span>
      </label>

      <label className="inline-field">
        <input
          type="checkbox"
          checked={ghostEnabled}
          onChange={(event) => setGhostEnabled(event.target.checked)}
        />
        Ghost overlay (repository values, same replay)
      </label>

      <section className="compare">
        <h3>Before / After on the same replay</h3>
        {comparison === null ? (
          <p className="muted">Select a replay.</p>
        ) : comparison.identical ? (
          <p className="muted">
            Identical within tolerance — the staged edits do not change this replay&apos;s outcome.
          </p>
        ) : (
          <ul className="diff-list">
            {comparison.differences.map((difference, index) => (
              <li key={index}>
                <strong>{difference.kind}</strong>
                {difference.tick !== null && <span className="muted"> @tick {difference.tick}</span>}
                <br />
                {difference.message}
                <br />
                <code>before: {difference.expected}</code>
                <br />
                <code>after: {difference.actual}</code>
              </li>
            ))}
          </ul>
        )}

        {beforeTrace && afterTrace && (
          <table className="metrics">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              <MetricRow label="Foot sliding (m)" before={beforeTrace.metrics.footSlidingDistance} after={afterTrace.metrics.footSlidingDistance} />
              <MetricRow label="Foot floating (ticks)" before={beforeTrace.metrics.footFloatingTicks} after={afterTrace.metrics.footFloatingTicks} />
              <MetricRow label="Max penetration (m)" before={beforeTrace.metrics.maxPenetration} after={afterTrace.metrics.maxPenetration} />
              <MetricRow label="Grounded flicker" before={beforeTrace.metrics.groundedFlickerCount} after={afterTrace.metrics.groundedFlickerCount} />
              <MetricRow label="Pelvis jerk" before={beforeTrace.metrics.pelvisJerk} after={afterTrace.metrics.pelvisJerk} />
              <MetricRow label="Root motion error (m)" before={beforeTrace.metrics.rootMotionError} after={afterTrace.metrics.rootMotionError} />
              <MetricRow label="Landing stabilization (ticks)" before={beforeTrace.metrics.landingStabilizationTicks} after={afterTrace.metrics.landingStabilizationTicks} />
              <MetricRow label="Platform drift (m)" before={beforeTrace.metrics.movingPlatformDrift} after={afterTrace.metrics.movingPlatformDrift} />
            </tbody>
          </table>
        )}
        <p className="muted small">
          These numbers are advisory. The human judgement in the viewport is the verdict.
        </p>
      </section>

      <section className="compare">
        <h3>A / B / C</h3>
        <button type="button" onClick={buildCompareSlots}>
          Rebuild comparison set
        </button>
        {compareSlots.length === 0 ? (
          <p className="muted">Ask the AI panel for proposals, then compare them here.</p>
        ) : (
          <div className="slot-row">
            {compareSlots.map((slot, index) => (
              <button
                type="button"
                key={slot.label}
                className={`slot${activeCompareSlot === index ? ' is-active' : ''}`}
                onClick={() => activateCompareSlot(index)}
              >
                <strong>{slot.label}</strong>
                {slot.trace && (
                  <span className="muted">
                    slide {slot.trace.metrics.footSlidingDistance.toFixed(3)}m ·{' '}
                    {slot.trace.metrics.stateSequence.length} states
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function MetricRow({ label, before, after }: { label: string; before: number; after: number }) {
  const changed = Math.abs(before - after) > 1e-6;
  return (
    <tr className={changed ? 'is-changed' : ''}>
      <td>{label}</td>
      <td>{before.toFixed(3)}</td>
      <td>{after.toFixed(3)}</td>
    </tr>
  );
}
