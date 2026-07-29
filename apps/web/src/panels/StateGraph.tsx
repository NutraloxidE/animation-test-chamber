import { useEffect, useMemo, useState } from 'react';
import { useChamber } from '../store.ts';

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
  const project = useChamber((state) => state.project);
  const selectedStateId = useChamber((state) => state.selectedStateId);
  const selectState = useChamber((state) => state.selectState);
  const selectTransition = useChamber((state) => state.selectTransition);
  const engine = useChamber((state) => state.engine);
  const [snapshot, setSnapshot] = useState(() => engine.snapshot());

  useEffect(() => engine.subscribe(() => setSnapshot(engine.snapshot())), [engine]);

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
    <div className="panel" data-testid="state-graph">
      <header className="panel__header">
        <h2>State Graph</h2>
        <span className="muted">live</span>
      </header>

      {project.graph.layers.map((layer) => (
        <section key={layer.id} className="graph-layer">
          {(() => {
            const runtime = snapshot.stateMachine[layer.id];
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
                const runtime = snapshot.stateMachine[layer.id];
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
                    snapshot.stateMachine[layer.id].lastTransitionId === transition.id
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
