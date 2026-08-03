/**
 * The bottom editor dock: Project, Animation Preview, Timeline, Graph, Replay.
 *
 * These were right-hand inspector tabs, which put "the properties of the thing
 * I selected" and "a state-machine editor" in the same strip of UI competing
 * for the same space. They are not the same kind of thing: an inspector is
 * about the selection, an editor workspace is a place you work. Splitting them
 * is what lets the Contextual Inspector stay visible while the graph is open —
 * previously, opening the graph hid whatever you were inspecting.
 *
 * Changing the workspace deliberately does not touch `sceneSelection`.
 */
import type { BottomWorkspace } from '../selection/asset-selection.ts';
import { useChamber } from '../store.ts';
import { ProjectWorkspace } from './ProjectWorkspace.tsx';
import { Timeline } from '../panels/Timeline.tsx';
import { ReplayPanel } from '../panels/ReplayPanel.tsx';
import { DiffPanel } from '../panels/DiffPanel.tsx';
import { AiPanel } from '../panels/AiPanel.tsx';
import { CapabilityPanel } from '../panels/CapabilityPanel.tsx';
import { AcquisitionPanel } from '../panels/AcquisitionPanel.tsx';
import { AnimationPreviewWorkspace } from './AnimationPreviewWorkspace.tsx';
import { GraphWorkspace } from './GraphWorkspace.tsx';

const WORKSPACES: { id: BottomWorkspace; label: string }[] = [
  { id: 'project', label: 'Project / Assets' },
  { id: 'animation-preview', label: 'Animation Preview' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'graph', label: 'Graph' },
  { id: 'replay', label: 'Replay' },
  // The secondary set. They are workspaces rather than inspector tabs for the
  // same reason as the five above: none of them is about the current
  // selection, so none of them belongs in the dock that is.
  { id: 'diff', label: 'Diff' },
  { id: 'ai', label: 'AI' },
  { id: 'acquisition', label: 'Import' },
  { id: 'capability', label: 'Haptics' },
];

function WorkspaceBody({ id }: { id: BottomWorkspace }) {
  switch (id) {
    case 'project':
      return <ProjectWorkspace />;
    case 'animation-preview':
      return <AnimationPreviewWorkspace />;
    case 'timeline':
      return <Timeline />;
    case 'graph':
      // Animator layers, states and transitions live here — not as children of
      // a scene node. A graph state is not something present in the world; it
      // is a rule about how the thing in the world moves.
      return <GraphWorkspace />;
    case 'replay':
      return <ReplayPanel />;
    case 'diff':
      return <DiffPanel />;
    case 'ai':
      return <AiPanel />;
    case 'acquisition':
      return <AcquisitionPanel />;
    case 'capability':
      return <CapabilityPanel />;
  }
}

export function BottomWorkspaceDock() {
  const workspace = useChamber((state) => state.bottomWorkspace);
  const setWorkspace = useChamber((state) => state.setBottomWorkspace);

  return (
    // `app__library-dock` carries the existing grid placement and the narrow
    // overlay behaviour — the dock moved from holding one panel to holding
    // several, which is not a reason to re-derive where the dock sits.
    <section className="app__library-dock workspace-dock" data-testid="workspace-dock">
      <nav className="workspace-dock__tabs">
        {WORKSPACES.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={workspace === entry.id ? 'is-active' : ''}
            onClick={() => setWorkspace(entry.id)}
            data-testid={`workspace-${entry.id}`}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div className="workspace-dock__body">
        <WorkspaceBody id={workspace} />
      </div>
    </section>
  );
}
