import { ACTION_LAYER, clipForState, layerStateOf } from '@atc/animation-runtime';
import { useEffect, useMemo, useState } from 'react';
import { dodgeRecoveryBlendWeight } from '@atc/animation-runtime';
import { useChamber, useWeaponProject } from '../store.ts';

interface GraphWarning {
  kind: 'unreachable' | 'conflict' | 'self-loop';
  message: string;
}

/**
 * State Graph (PLAN 8.3). Deliberately not a free-form node editor: states are
 * laid out per layer, and the panel's real job is to surface unreachable states,
 * conflicting transitions and self-loops.
 */
export function StateGraph() {
  const project = useWeaponProject();
  const selectedStateId = useChamber((state) => state.selectedStateId);
  const selectState = useChamber((state) => state.selectState);
  const selectTransition = useChamber((state) => state.selectTransition);
  const engine = useChamber((state) => state.engine);
  const [snapshot, setSnapshot] = useState(() => engine.snapshot());

  useEffect(() => engine.subscribe(() => setSnapshot(engine.snapshot())), [engine]);

  // Layers are named by the behaviour asset, so a missing one is possible and
  // renders as an empty action layer rather than crashing the panel.
  const actionRuntime = layerStateOf(snapshot.stateMachine, ACTION_LAYER);
  const actionDefault =
    project.graph.layers.find((layer) => layer.id === ACTION_LAYER)?.defaultState ?? 'action-none';
  const actionState = project.graph.states.find((state) => state.id === actionRuntime.stateId);
  const locomotionState = project.graph.states.find(
    (state) => state.id === snapshot.locomotionState,
  );
  const actionClip = actionState ? clipForState(project, actionState.id) : undefined;
  const recoveryWeight = dodgeRecoveryBlendWeight(
    actionState,
    actionRuntime.normalizedTime,
    actionClip?.durationSec ?? 0,
    locomotionState,
    actionClip?.recoveryTransitionStartNormalized,
  );
  const actionWeight =
    recoveryWeight > 0
      ? 1 - recoveryWeight
      : actionRuntime.stateId === actionDefault
        ? actionRuntime.previousStateId
          ? 1 - actionRuntime.blendWeight
          : 0
          : actionRuntime.previousStateId === actionDefault
          ? actionRuntime.blendWeight
          : 1;
  const previousActionId =
    actionRuntime.previousStateId && actionRuntime.previousStateId !== actionDefault
      ? actionRuntime.previousStateId
      : null;
  const previousActionWeight = previousActionId
    ? actionRuntime.stateId === actionDefault
      ? actionWeight
      : Math.min(actionWeight, 1 - actionRuntime.blendWeight)
    : 0;
  const currentActionWeight = Math.max(0, actionWeight - previousActionWeight);
  const locomotionWeight = 1 - actionWeight;

  const warnings = useMemo<GraphWarning[]>(() => {
    const found: GraphWarning[] = [];
    const states = project.graph.states;
    const transitions = project.graph.transitions;

    for (const layer of project.graph.layers) {
      const reachable = new Set<string>([layer.defaultState]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const transition of transitions) {
          const target = states.find((s) => s.id === transition.to);
          if (!target || target.layer !== layer.id) continue;
          if ((transition.from === '*' || reachable.has(transition.from)) && !reachable.has(transition.to)) {
            reachable.add(transition.to);
            grew = true;
          }
        }
      }
      for (const state of states.filter((s) => s.layer === layer.id)) {
        if (!reachable.has(state.id)) {
          found.push({ kind: 'unreachable', message: `"${state.id}" is unreachable` });
        }
      }
    }

    // Two transitions from the same source, to the same target, at the same
    // priority: which one wins is decided by id ordering, which is not a design.
    const seen = new Map<string, string>();
    for (const transition of transitions) {
      const key = `${transition.from}->${transition.to}@${transition.priority}`;
      const previous = seen.get(key);
      if (previous) {
        found.push({
          kind: 'conflict',
          message: `"${transition.id}" and "${previous}" have the same source, target and priority`,
        });
      }
      seen.set(key, transition.id);
      if (transition.from === transition.to) {
        const state = states.find((s) => s.id === transition.to);
        if (!state?.allowReEntry) {
          found.push({
            kind: 'self-loop',
            message: `"${transition.id}" loops onto a state that forbids re-entry`,
          });
        }
      }
    }

    return found;
  }, [project]);

  return (
    <div className="panel state-graph" data-testid="state-graph">
      <header className="panel__header">
        <h2>State Graph</h2>
        <span className="muted">live</span>
      </header>

      <section className="layer-mix" data-testid="layer-mix">
        <div className="layer-mix__sticky">
          <div className="layer-mix__gauge" aria-label="Locomotion and action layer mix">
            {previousActionId && (
              <span
                className={`layer-mix__action layer-mix__action--${previousActionId}`}
                style={{ height: `${previousActionWeight * 100}%` }}
                title={`${previousActionId} ${Math.round(previousActionWeight * 100)}%`}
                data-state={previousActionId}
                data-weight={previousActionWeight.toFixed(3)}
              />
            )}
            <span
              className={`layer-mix__action layer-mix__action--${actionRuntime.stateId}`}
              style={{ height: `${currentActionWeight * 100}%` }}
              title={`${actionRuntime.stateId} ${Math.round(currentActionWeight * 100)}%`}
              data-state={actionRuntime.stateId}
              data-weight={currentActionWeight.toFixed(3)}
            />
            <span
              className="layer-mix__locomotion"
              style={{ height: `${locomotionWeight * 100}%` }}
              data-weight={locomotionWeight.toFixed(3)}
            />
          </div>
          <div className="layer-mix__labels">
            <span>
              ACTION <strong>{Math.round(actionWeight * 100)}%</strong>
            </span>
            <span>
              LOCOMOTION <strong>{Math.round(locomotionWeight * 100)}%</strong>
            </span>
          </div>
        </div>
      </section>

      {project.graph.layers.map((layer) => (
        <section key={layer.id} className="graph-layer">
          {(() => {
            const runtime = layerStateOf(snapshot.stateMachine, layer.id);
            const transitioning = runtime.previousStateId !== null;
            return (
              <div className="graph-live" data-testid={`graph-live-${layer.id}`}>
                <div>
                  <span className="graph-live__layer">{layer.id}</span>
                  <strong>{runtime.stateId}</strong>
                </div>
                <span className="muted">
                  {transitioning
                    ? `${runtime.previousStateId} → ${runtime.stateId} · blend ${Math.round(
                        runtime.blendWeight * 100,
                      )}%`
                    : `playing ${Math.round(runtime.normalizedTime * 100)}%`}
                </span>
                <span className="graph-live__track" aria-hidden="true">
                  <span
                    style={{
                      width: `${(transitioning
                        ? runtime.blendWeight
                        : runtime.normalizedTime) * 100}%`,
                    }}
                  />
                </span>
              </div>
            );
          })()}
          <h3>
            {layer.id} <span className="muted">default: {layer.defaultState}</span>
          </h3>
          <div className="graph-states">
            {project.graph.states
              .filter((state) => state.layer === layer.id)
              .map((state) => {
                const active =
                  layer.id === 'locomotion'
                    ? snapshot.locomotionState === state.id
                    : snapshot.actionState === state.id;
                const progress = active
                  ? layer.id === 'locomotion'
                    ? snapshot.locomotionNormalizedTime
                    : snapshot.actionNormalizedTime
                  : 0;
                return (
                  <button
                    type="button"
                    key={state.id}
                    className={`graph-node${active ? ' is-active' : ''}${
                      selectedStateId === state.id ? ' is-selected' : ''
                    }`}
                    onClick={() => selectState(state.id)}
                  >
                    <span
                      className="graph-node__progress"
                      style={{ width: `${progress * 100}%` }}
                      aria-hidden="true"
                    />
                    <span className="graph-node__label">{state.id}</span>
                  </button>
                );
              })}
          </div>

          <ul className="graph-transitions">
            {project.graph.transitions
              .filter((transition) => {
                const target = project.graph.states.find((s) => s.id === transition.to);
                if (target?.layer !== layer.id) return false;
                const runtime = layerStateOf(snapshot.stateMachine, layer.id);
                return (
                  transition.from === selectedStateId ||
                  transition.to === selectedStateId ||
                  transition.from === runtime.stateId ||
                  transition.to === runtime.stateId ||
                  transition.id === runtime.lastTransitionId ||
                  transition.from === '*'
                );
              })
              .map((transition) => (
                <li
                  key={transition.id}
                  className={
                    layerStateOf(snapshot.stateMachine, layer.id).lastTransitionId ===
                    transition.id
                      ? 'is-live'
                      : ''
                  }
                >
                  <button type="button" onClick={() => selectTransition(transition.id)}>
                    <code>
                      {transition.from} → {transition.to}
                    </code>
                    <span className="muted">
                      p{transition.priority} · {transition.blendDurationSec.toFixed(2)}s
                      {transition.cancelWindow
                        ? ` · cancel ${transition.cancelWindow.start}–${transition.cancelWindow.end}`
                        : ''}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}

      <section className={`warnings${warnings.length === 0 ? ' warnings--clear' : ''}`}>
        <h3>Graph checks</h3>
        {warnings.length === 0 ? (
          <p className="muted">No unreachable states, priority conflicts or illegal self-loops.</p>
        ) : (
          <ul>
            {warnings.map((warning, index) => (
              <li key={index} className={`warning warning--${warning.kind}`}>
                {warning.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
