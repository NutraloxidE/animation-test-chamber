import { useState } from 'react';
import { useChamber } from '../store.ts';
import { Field, ToggleField } from './Field.tsx';

type TimeUnit = 'seconds' | 'frames30' | 'frames60';

/**
 * Transition Inspector (PLAN 8.2). Every value here is written straight into the
 * preview document, so a drag is visible in the running character immediately.
 */
export function TransitionInspector() {
  const project = useChamber((state) => state.project);
  const selectedId = useChamber((state) => state.selectedTransitionId);
  const selectTransition = useChamber((state) => state.selectTransition);
  const [unit, setUnit] = useState<TimeUnit>('seconds');

  const transition = project.graph.transitions.find((entry) => entry.id === selectedId);
  const base = `/graph/transitions/${selectedId}`;

  const formatTime = (seconds: number): string => {
    if (unit === 'frames30') return `${(seconds * 30).toFixed(1)} f@30`;
    if (unit === 'frames60') return `${(seconds * 60).toFixed(1)} f@60`;
    return `${seconds.toFixed(3)} s`;
  };

  if (!transition) {
    return <div className="panel">No transition selected.</div>;
  }

  return (
    <div className="panel" data-testid="transition-inspector">
      <header className="panel__header">
        <h2>Transition Inspector</h2>
        <select value={unit} onChange={(event) => setUnit(event.target.value as TimeUnit)}>
          <option value="seconds">seconds</option>
          <option value="frames30">frames @30</option>
          <option value="frames60">frames @60</option>
        </select>
      </header>

      <select
        className="wide"
        value={selectedId}
        onChange={(event) => selectTransition(event.target.value)}
        data-testid="transition-select"
      >
        {project.graph.transitions.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.from} → {entry.to} ({entry.id})
          </option>
        ))}
      </select>

      {transition.provenance?.intent && (
        <p className="provenance">
          <strong>Recorded intent:</strong> {transition.provenance.intent}
          {transition.provenance.basedOnAiProposal !== undefined && (
            <>
              {' '}
              (AI proposed {transition.provenance.basedOnAiProposal}, human chose{' '}
              {transition.provenance.humanFinal})
            </>
          )}
        </p>
      )}

      <Field
        path={`${base}/blendDurationSec`}
        label="Blend duration"
        min={0}
        max={0.6}
        step={0.005}
        format={formatTime}
      />
      <Field
        path={`${base}/startOffsetNormalized`}
        label="Start offset"
        min={0}
        max={0.9}
        step={0.005}
      />
      <Field path={`${base}/playbackSpeed`} label="Playback speed" min={0.2} max={2.5} step={0.01} />
      <Field
        path={`${base}/exitTimeNormalized`}
        label="Exit time"
        min={0}
        max={1}
        step={0.01}
      />
      <Field
        path={`${base}/inputBufferMs`}
        label="Input buffer"
        min={0}
        max={500}
        step={5}
        format={(value) => `${value.toFixed(0)} ms`}
      />
      <Field
        path={`${base}/momentumRetention`}
        label="Momentum retention"
        min={0}
        max={1}
        step={0.01}
      />
      <Field
        path={`${base}/rotationAuthority`}
        label="Rotation authority"
        min={0}
        max={1}
        step={0.01}
      />
      <Field path={`${base}/priority`} label="Priority" min={0} max={300} step={1} format={(v) => v.toFixed(0)} />

      {transition.cancelWindow && (
        <>
          <Field
            path={`${base}/cancelWindow/start`}
            label="Cancel window start"
            min={0}
            max={1}
            step={0.01}
          />
          <Field
            path={`${base}/cancelWindow/end`}
            label="Cancel window end"
            min={0}
            max={1}
            step={0.01}
          />
        </>
      )}

      <ToggleField path={`${base}/interruptible`} label="Interruptible" />

      <div className="field">
        <label className="field__label" htmlFor={`${base}-rootmotion`}>
          Root motion mode
        </label>
        <select
          id={`${base}-rootmotion`}
          value={transition.rootMotionMode ?? project.rootMotion.mode}
          onChange={(event) =>
            useChamber.getState().setPreviewValue(`${base}/rootMotionMode`, event.target.value)
          }
        >
          <option value="InPlace">InPlace</option>
          <option value="RootMotion">RootMotion</option>
          <option value="Hybrid">Hybrid</option>
        </select>
      </div>

      <details className="conditions">
        <summary>Conditions ({transition.conditions.length})</summary>
        <ul>
          {transition.conditions.map((condition, index) => (
            <li key={index}>
              <code>
                {condition.parameter} {condition.operator} {String(condition.value)}
              </code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
