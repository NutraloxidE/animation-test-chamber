/**
 * State, Transition and Motion details — one at a time.
 *
 * They used to render simultaneously, stacked below the graph, which meant the
 * graph got whatever vertical space the two of them left over and neither
 * detail panel got enough. Selecting a state opens Motion, selecting a
 * transition opens Transition, and the user can override either — the tabs are
 * a routing hint, not a lock.
 */
import { useChamber } from '../store.ts';
import { TransitionInspector } from '../panels/TransitionInspector.tsx';
import { MotionTimingPanel } from '../panels/MotionTimingPanel.tsx';
import type { GraphDetailsTab } from './graph-target.ts';

const TABS: { id: GraphDetailsTab; label: string }[] = [
  { id: 'state', label: 'State' },
  { id: 'transition', label: 'Transition' },
  { id: 'motion', label: 'Motion' },
];

function StateDetails() {
  const project = useChamber((state) => state.graphProject());
  const selectedStateId = useChamber((state) => state.selectedStateId);
  const state = project.graph.states.find((entry) => entry.id === selectedStateId);

  if (!state) {
    return (
      <p className="workspace__hint" data-testid="graph-state-details-empty">
        No state selected in this Behavior.
      </p>
    );
  }

  return (
    <dl className="graph-details__state" data-testid="graph-state-details">
      <div>
        <dt>State</dt>
        <dd>{state.id}</dd>
      </div>
      <div>
        <dt>Layer</dt>
        <dd>{state.layer}</dd>
      </div>
      <div>
        <dt>Motion slot</dt>
        <dd>{state.motionSlot}</dd>
      </div>
      <div>
        <dt>Speed</dt>
        <dd>{state.speed}</dd>
      </div>
      <div>
        <dt>Interruptible</dt>
        <dd>{state.interruptible ? 'yes' : 'no'}</dd>
      </div>
      <div>
        <dt>Completion</dt>
        <dd>{state.completionPolicy.mode}</dd>
      </div>
      <div>
        <dt>Fallback</dt>
        <dd>{state.fallbackState ?? '—'}</dd>
      </div>
    </dl>
  );
}

export function GraphDetails() {
  const tab = useChamber((state) => state.graphDetailsTab);
  const setTab = useChamber((state) => state.setGraphDetailsTab);

  return (
    <div className="graph-details" data-testid="graph-details">
      <nav className="graph-details__tabs" data-testid="graph-details-tabs">
        {TABS.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={tab === entry.id ? 'is-active' : ''}
            data-testid={`graph-details-tab-${entry.id}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="graph-details__body">
        {tab === 'state' && <StateDetails />}
        {tab === 'transition' && <TransitionInspector />}
        {tab === 'motion' && <MotionTimingPanel />}
      </div>
    </div>
  );
}
