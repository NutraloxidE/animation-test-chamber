/**
 * Layers, states, transitions and their timing — all in one place.
 *
 * These three panels were three separate right-hand tabs, which meant editing
 * a transition and seeing the graph it belongs to were mutually exclusive.
 * They are one job. Bringing them together is also what let the animator
 * subtree leave the Scene Hierarchy without losing anything: a graph state was
 * never a scene object, and the reason it had been pressed into service as one
 * is that the tree was the only navigation the chamber had.
 *
 * Graph-local selection (`selectedStateId`, `selectedTransitionId`) stays in
 * the store and stays separate from `SceneSelection`. Selecting a state is not
 * selecting a thing in the world.
 */
import { StateGraph } from '../panels/StateGraph.tsx';
import { TransitionInspector } from '../panels/TransitionInspector.tsx';
import { MotionTimingPanel } from '../panels/MotionTimingPanel.tsx';

export function GraphWorkspace() {
  return (
    <div className="workspace workspace--graph" data-testid="graph-workspace">
      <div className="workspace--graph__graph">
        <StateGraph />
      </div>
      <div className="workspace--graph__details">
        <TransitionInspector />
        <MotionTimingPanel />
      </div>
    </div>
  );
}
