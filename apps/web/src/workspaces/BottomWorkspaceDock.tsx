/**
 * The bottom editor dock: Project, Animation, Graph, Timeline, Replay, tools.
 *
 * These were right-hand inspector tabs, which put "the properties of the thing
 * I selected" and "a state-machine editor" in the same strip of UI competing
 * for the same space. They are not the same kind of thing: an inspector is
 * about the selection, an editor workspace is a place you work. Splitting them
 * is what lets the Contextual Inspector stay visible while the graph is open —
 * previously, opening the graph hid whatever you were inspecting.
 *
 * The tabs are grouped rather than flat. Nine peers in one strip is a list you
 * read rather than a structure you navigate, and at narrow widths it was a
 * horizontal scroll with the tool you wanted somewhere off the right edge.
 * CREATE / ANIMATE / TOOLS is the smallest grouping that makes the dock
 * scannable without turning it into a menu.
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
import { AnimationWorkspace } from './AnimationWorkspace.tsx';
import { GraphWorkspace } from './GraphWorkspace.tsx';

interface WorkspaceGroup {
  id: string;
  label: string;
  entries: { id: BottomWorkspace; label: string }[];
}

const GROUPS: WorkspaceGroup[] = [
  {
    id: 'create',
    label: 'Create',
    entries: [
      { id: 'project', label: 'Project / Assets' },
      { id: 'acquisition', label: 'Import' },
    ],
  },
  {
    id: 'animate',
    label: 'Animate',
    entries: [
      { id: 'animation', label: 'Animation' },
      { id: 'graph', label: 'Graph' },
      { id: 'timeline', label: 'Timeline' },
      { id: 'replay', label: 'Replay' },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    entries: [
      { id: 'ai', label: 'AI' },
      { id: 'diff', label: 'Diff' },
      { id: 'capability', label: 'Haptics' },
    ],
  },
];

function WorkspaceBody({ id }: { id: BottomWorkspace }) {
  switch (id) {
    case 'project':
      return <ProjectWorkspace />;
    case 'animation':
      return <AnimationWorkspace />;
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
        {GROUPS.map((group) => (
          <span key={group.id} className="workspace-dock__group" data-testid={`workspace-group-${group.id}`}>
            <span className="workspace-dock__group-label">{group.label}</span>
            {group.entries.map((entry) => (
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
          </span>
        ))}
      </nav>
      <div className="workspace-dock__body">
        <WorkspaceBody id={workspace} />
      </div>
    </section>
  );
}
