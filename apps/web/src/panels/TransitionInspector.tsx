import {
  ACTION_LAYER,
  LOCOMOTION_LAYER,
  clipForState,
  clipIdForState,
  layerStateOf,
} from '@atc/animation-runtime';
import { useEffect, useState } from 'react';
import type { TransitionDefinition } from '@atc/schema';
import { useChamber, useWeaponProject } from './chamber-source.ts';
import { Field, ToggleField } from './Field.tsx';

type TimeUnit = 'seconds' | 'frames30' | 'frames60';

function ActionPlayback({
  isLive,
  progress,
  inputStart,
  testId,
}: {
  isLive: boolean;
  progress: number;
  inputStart: number;
  testId?: string;
}) {
  return (
    <div className="action-input-playback" data-testid={testId}>
      <div className="action-input-playback__status">
        <span>{isLive ? `PLAYING ${progress}%` : 'NOT PLAYING'}</span>
        {isLive && <strong>{progress / 100 >= inputStart ? 'INPUT OPEN' : 'INPUT LOCKED'}</strong>}
      </div>
      <div className="action-input-playback__track" aria-hidden="true">
        <span
          className="action-input-playback__fill"
          style={{ width: `${isLive ? progress : 0}%` }}
        />
        <span
          className="action-input-playback__marker"
          style={{ left: `${inputStart * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Attack clips are named per weapon (`sword-attack-01`), so the swing is matched
 * on the attack part rather than on the start of the id.
 */
const isAttackClip = (clipId: string): boolean => /attack-\d/.test(clipId);

type BlendSort = 'graph' | 'duration' | 'name';

const transitionLabel = (transition: TransitionDefinition): string =>
  `${transition.from} → ${transition.to}`;

/**
 * Filters and orders the blend list. Authored order is the default because it
 * is how the graph reads; sorting by duration is what finds the one transition
 * that is slower than everything around it.
 */
export function blendRows(
  transitions: TransitionDefinition[],
  query: string,
  sort: BlendSort,
): TransitionDefinition[] {
  const needle = query.trim().toLowerCase();
  const rows = transitions.filter((entry) =>
    `${entry.id} ${entry.from} ${entry.to}`.toLowerCase().includes(needle),
  );
  if (sort === 'duration') {
    return [...rows].sort((a, b) => b.blendDurationSec - a.blendDurationSec);
  }
  if (sort === 'name') {
    return [...rows].sort((a, b) => transitionLabel(a).localeCompare(transitionLabel(b)));
  }
  return rows;
}

/**
 * Transition Inspector (PLAN 8.2). Every value here is written straight into the
 * preview document, so a drag is visible in the running character immediately.
 */
export function TransitionInspector() {
  const project = useWeaponProject();
  const selectedId = useChamber((state) => state.selectedTransitionId);
  const selectTransition = useChamber((state) => state.selectTransition);
  const engine = useChamber((state) => state.engine);
  const [unit, setUnit] = useState<TimeUnit>('seconds');
  const [blendQuery, setBlendQuery] = useState('');
  const [blendSort, setBlendSort] = useState<BlendSort>('graph');
  const [selectedClipId, setSelectedClipId] = useState(
    project.clips.some((clip) => clip.id === 'dodge') ? 'dodge' : project.clips[0]?.id ?? '',
  );

  // A selection can go stale when the graph changes under it (or is restored
  // from a previous session), so fall back to the first transition.
  const transition =
    project.graph.transitions.find((entry) => entry.id === selectedId) ??
    project.graph.transitions[0];
  const selectedClip =
    project.clips.find((clip) => clip.id === selectedClipId) ?? project.clips[0];
  const actionClips = project.graph.states
    .filter((state) => state.layer === 'action' && state.id !== 'action-none')
    .flatMap((state) => {
      const clip = clipForState(project, state.id);
      return clip ? [clip] : [];
    })
    .filter((clip, index, clips) => clips.indexOf(clip) === index);
  const base = `/graph/transitions/${transition?.id}`;

  /**
   * The transition each layer is currently living in. Only stored when it
   * actually changes: the engine notifies every frame, and re-rendering a list
   * of sliders at 60fps to say nothing happened is not worth the frame budget.
   * The fade back down afterwards is a CSS transition, so it costs no renders.
   */
  const [liveIds, setLiveIds] = useState<(string | null)[]>([]);
  const [liveAction, setLiveAction] = useState(() => {
    const action = layerStateOf(engine.graphLayers, ACTION_LAYER);
    return { stateId: action.stateId, progress: Math.round(action.normalizedTime * 100) };
  });
  useEffect(
    () =>
      engine.subscribe(() => {
        const action = layerStateOf(engine.graphLayers, ACTION_LAYER);
        const locomotion = layerStateOf(engine.graphLayers, LOCOMOTION_LAYER);
        setLiveIds((previous) =>
          previous[0] === action.lastTransitionId &&
          previous[1] === locomotion.lastTransitionId
            ? previous
            : [action.lastTransitionId, locomotion.lastTransitionId],
        );
        const nextAction = {
          stateId: action.stateId,
          progress: Math.round(action.normalizedTime * 100),
        };
        setLiveAction((previous) =>
          previous.stateId === nextAction.stateId && previous.progress === nextAction.progress
            ? previous
            : nextAction,
        );
      }),
    [engine],
  );

  const matchingBlends = blendRows(project.graph.transitions, blendQuery, blendSort);

  const layerOf = (stateId: string): string =>
    project.graph.states.find((state) => state.id === stateId)?.layer ?? 'locomotion';

  const formatTime = (seconds: number): string => {
    if (unit === 'frames30') return `${(seconds * 30).toFixed(1)} f@30`;
    if (unit === 'frames60') return `${(seconds * 60).toFixed(1)} f@60`;
    return `${seconds.toFixed(3)} s`;
  };

  if (!transition) {
    return <div className="panel">This graph has no transitions.</div>;
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
        value={transition.id}
        onChange={(event) => selectTransition(event.target.value)}
        data-testid="transition-select"
      >
        {project.graph.transitions.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.from} → {entry.to} ({entry.id})
          </option>
        ))}
      </select>

      {/*
        Tuning "how fast does everything switch" means comparing blends against
        each other, which the one-transition-at-a-time view above cannot do. The
        sliders are the same Field, so protection, reset and staging still apply.
      */}
      <details className="blend-list" data-testid="blend-list">
        <summary>
          All blend durations ({matchingBlends.length}
          {matchingBlends.length === project.graph.transitions.length
            ? ''
            : ` of ${project.graph.transitions.length}`}
          )
        </summary>
        <div className="blend-filter">
          <input
            type="search"
            value={blendQuery}
            onChange={(event) => setBlendQuery(event.target.value)}
            placeholder="Filter by state or id"
            aria-label="Filter blend durations"
            data-testid="blend-filter"
          />
          <select
            value={blendSort}
            onChange={(event) => setBlendSort(event.target.value as BlendSort)}
            aria-label="Sort blend durations"
            data-testid="blend-sort"
          >
            <option value="graph">graph order</option>
            <option value="duration">longest first</option>
            <option value="name">name</option>
          </select>
        </div>
        {(['action', 'locomotion'] as const).map((layer) => (
          <section key={layer}>
            <h3>{layer}</h3>
            {matchingBlends
              .filter((entry) => layerOf(entry.to) === layer)
              .map((entry) => (
                <div
                  key={entry.id}
                  className={`blend-row${liveIds.includes(entry.id) ? ' blend-row--live' : ''}`}
                >
                  <Field
                    path={`/graph/transitions/${entry.id}/blendDurationSec`}
                    testId={`blend-${entry.id}`}
                    label={`${entry.from} → ${entry.to}`}
                    min={0}
                    max={0.6}
                    step={0.005}
                    format={formatTime}
                  />
                </div>
              ))}
          </section>
        ))}
      </details>

      <details className="blend-list" data-testid="action-input-list">
        <summary>All action input starts ({actionClips.length})</summary>
        {actionClips.map((clip) => {
          const isLive = project.graph.states.some(
            (state) => state.id === liveAction.stateId && clipIdForState(project, state.id) === clip.id,
          );
          const inputStart = clip.inputAcceptanceStartNormalized ?? 0;
          return (
            <div
              key={clip.id}
              className={`blend-row action-input-row${isLive ? ' blend-row--live' : ''}`}
              data-progress={isLive ? liveAction.progress : 0}
            >
              <ActionPlayback
                isLive={isLive}
                progress={liveAction.progress}
                inputStart={inputStart}
              />
              <Field
                path={`/clips/${clip.id}/inputAcceptanceStartNormalized`}
                testId={`action-input-${clip.id}`}
                label={clip.id}
                min={0}
                max={1}
                step={0.01}
                format={(value) => `${Math.round(value * 100)}%`}
              />
            </div>
          );
        })}
      </details>

      {selectedClip && (
        <section>
          <h3>Clip tuning</h3>
          <select
            className="wide"
            value={selectedClip.id}
            onChange={(event) => setSelectedClipId(event.target.value)}
            data-testid="clip-select"
          >
            {project.clips.map((clip) => (
              <option key={clip.id} value={clip.id}>
                {clip.id}
              </option>
            ))}
          </select>
          <Field
            path={`/clips/${selectedClip.id}/rootDisplacement/z`}
            label={
              isAttackClip(selectedClip.id)
                ? 'Forward displacement adjustment'
                : 'Forward displacement'
            }
            min={-2}
            max={isAttackClip(selectedClip.id) ? 2 : 10}
            step={isAttackClip(selectedClip.id) ? 0.05 : 0.1}
            format={(value) =>
              isAttackClip(selectedClip.id)
                ? `${value >= 0 ? '+' : ''}${value.toFixed(2)} m`
                : `${value.toFixed(1)} m`
            }
          />
          {selectedClip.inputAcceptanceStartNormalized !== undefined && (
            <div
              className={
                project.graph.states.some(
                  (state) =>
                    state.id === liveAction.stateId &&
                    clipIdForState(project, state.id) === selectedClip.id,
                )
                  ? 'action-input-detail blend-row--live'
                  : 'action-input-detail'
              }
            >
              <ActionPlayback
                isLive={project.graph.states.some(
                  (state) =>
                    state.id === liveAction.stateId &&
                    clipIdForState(project, state.id) === selectedClip.id,
                )}
                progress={liveAction.progress}
                inputStart={selectedClip.inputAcceptanceStartNormalized}
                testId="selected-action-playback"
              />
              <Field
                path={`/clips/${selectedClip.id}/inputAcceptanceStartNormalized`}
                label="Next input acceptance start"
                min={0}
                max={1}
                step={0.01}
                format={(value) => `${Math.round(value * 100)}%`}
              />
            </div>
          )}
          {selectedClip.recoveryTransitionStartNormalized !== undefined && (
            <Field
              path={`/clips/${selectedClip.id}/recoveryTransitionStartNormalized`}
              label="Recovery transition start"
              min={0.5}
              max={0.95}
              step={0.01}
            />
          )}
        </section>
      )}

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
