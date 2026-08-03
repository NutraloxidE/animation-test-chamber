/**
 * Layers, states, transitions and their timing — with the Behavior named.
 *
 * These three panels were three separate right-hand tabs, which meant editing
 * a transition and seeing the graph it belongs to were mutually exclusive.
 * They are one job. Bringing them together is also what let the animator
 * subtree leave the Scene Hierarchy without losing anything: a graph state was
 * never a scene object, and the reason it had been pressed into service as one
 * is that the tree was the only navigation the chamber had.
 *
 * What is new is the header. The graph used to edit "the" behaviour, which is
 * an answer only as long as there is one — and edits here land in a *shared*
 * asset, so "which one, and where did it come from" is the difference between
 * an intentional change and a surprise in somebody else's character.
 *
 * Graph-local selection (`selectedStateId`, `selectedTransitionId`) stays in
 * the store and stays separate from `SceneSelection`. Selecting a state is not
 * selecting a thing in the world — but it *is* reconciled when the target
 * changes, because an id from another Behavior is a dangling reference.
 */
import { StateGraph } from '../panels/StateGraph.tsx';
import { GraphDetails } from './GraphDetails.tsx';
import { useChamber } from '../store.ts';
import { useAnimationTarget } from '../animation/target/useAnimationTarget.ts';
import { WEAPON_MODES } from '../three/catalog.ts';

function GraphHeader() {
  const graphTarget = useChamber((state) => state.graphTarget);
  const setGraphTarget = useChamber((state) => state.setGraphTarget);
  const context = useChamber((state) => state.motionBindingContext);
  const setContext = useChamber((state) => state.setMotionBindingContext);
  const adopt = useChamber((state) => state.adoptTargetBindingContext);
  const { resolved } = useAnimationTarget();
  const target = resolved?.ok ? resolved.target : null;

  return (
    <header className="graph-header" data-testid="graph-header">
      <h2>Graph</h2>
      <span className="workspace__badge">AUTHORED</span>
      <span className="workspace__badge" data-testid="graph-shared-badge">
        SHARED
      </span>

      <span className="graph-header__field">
        Behavior
        <b data-testid="graph-behavior">
          {target ? `${target.behaviorRef.assetId}@${target.behaviorRef.version}` : '—'}
        </b>
      </span>
      <span className="graph-header__field">
        From
        <b data-testid="graph-from-instance">{target?.instanceId ?? '—'}</b>
      </span>

      <button
        type="button"
        data-testid="graph-target-mode"
        onClick={() => setGraphTarget({ kind: 'follow-animation-target' })}
        className={graphTarget.kind === 'follow-animation-target' ? 'is-active' : ''}
      >
        Follow Animation Target
      </button>

      {/* Binding Context, not loadout. Changing it changes which contextual
          binding the panels below resolve through — it dispatches no world
          command, stages nothing and dirties nothing. The previous control
          here called `setInstanceWeaponMode`, so inspecting the sword's timing
          put a sword in the character's hand. */}
      <label className="graph-header__context" data-testid="graph-binding-context">
        Binding Context
        <select
          value={context.weaponModeId}
          data-testid="graph-binding-weapon"
          onChange={(event) => setContext({ ...context, weaponModeId: event.target.value })}
        >
          {WEAPON_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.id}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        data-testid="graph-adopt-context"
        disabled={target === null}
        title="Copy the animation target's effective loadout into the inspected context."
        onClick={() => adopt()}
      >
        Use target’s context
      </button>
    </header>
  );
}

export function GraphWorkspace() {
  return (
    <div className="workspace workspace--graph" data-testid="graph-workspace">
      <GraphHeader />
      <div className="workspace--graph__graph">
        <StateGraph />
      </div>
      <div className="workspace--graph__details">
        <GraphDetails />
      </div>
    </div>
  );
}
