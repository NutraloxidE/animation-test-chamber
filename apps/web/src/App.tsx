import { useEffect, useState } from 'react';
import { detectTouchDevice } from '@atc/input-runtime';
import { useChamber, type PanelId } from './store.ts';
import { Viewport } from './three/Viewport.tsx';
import { TransitionInspector } from './panels/TransitionInspector.tsx';
import { StateGraph } from './panels/StateGraph.tsx';
import { Timeline } from './panels/Timeline.tsx';
import { MotionTimingPanel } from './panels/MotionTimingPanel.tsx';
import { ReplayPanel } from './panels/ReplayPanel.tsx';
import { DiffPanel } from './panels/DiffPanel.tsx';
import { AiPanel } from './panels/AiPanel.tsx';
import { CapabilityPanel } from './panels/CapabilityPanel.tsx';
import { TerrainPanel } from './panels/TerrainPanel.tsx';
import { AcquisitionPanel } from './panels/AcquisitionPanel.tsx';
import { MobilePad } from './panels/MobilePad.tsx';
import { Hierarchy } from './panels/Hierarchy.tsx';
import { AssetLibrary } from './asset-library/AssetLibrary.tsx';
import { SaveDestinationDialog } from './asset-library/SaveDestinationDialog.tsx';
import type { MouseLookMode } from '@atc/input-runtime';
import { characterPreset, weaponMode } from './three/catalog.ts';

const PANELS: { id: PanelId; label: string }[] = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'graph', label: 'Graph' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'timing', label: 'Timing' },
  { id: 'replay', label: 'Replay' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'ai', label: 'AI' },
  { id: 'diff', label: 'Diff' },
  { id: 'capability', label: 'Haptics' },
  // Renamed from "Assets" (PLAN 29): the Asset Library is where assets live
  // now, and this panel does one specific thing — bring new motion in.
  { id: 'acquisition', label: 'Import' },
];

function PanelBody({ id }: { id: PanelId }) {
  switch (id) {
    case 'inspector':
      return <TransitionInspector />;
    case 'graph':
      return <StateGraph />;
    case 'timeline':
      return <Timeline />;
    case 'timing':
      return <MotionTimingPanel />;
    case 'replay':
      return <ReplayPanel />;
    case 'terrain':
      return <TerrainPanel />;
    case 'ai':
      return <AiPanel />;
    case 'diff':
      return <DiffPanel />;
    case 'capability':
      return <CapabilityPanel />;
    case 'acquisition':
      return <AcquisitionPanel />;
  }
}

/** Live readout of what the simulation is doing right now. */
function Hud() {
  const engine = useChamber((state) => state.engine);
  const [snapshot, setSnapshot] = useState(() => engine.snapshot());

  useEffect(() => {
    // The engine notifies every tick; sampling on an interval keeps React
    // re-renders off the simulation's critical path.
    const interval = window.setInterval(() => setSnapshot(engine.snapshot()), 100);
    return () => window.clearInterval(interval);
  }, [engine]);

  return (
    <div className="hud" data-testid="hud">
      <span className="hud__item">
        <b>{snapshot.locomotionState}</b>
        <em>locomotion</em>
      </span>
      <span className="hud__item">
        <b>{snapshot.actionState}</b>
        <em>action</em>
      </span>
      <span className="hud__item">
        <b>{snapshot.terrainState}</b>
        <em>terrain</em>
      </span>
      <span className="hud__item">
        <b>{snapshot.speed.toFixed(2)} m/s</b>
        <em>speed</em>
      </span>
      <span className="hud__item">
        <b>{snapshot.blendWeight.toFixed(2)}</b>
        <em>blend</em>
      </span>
      <span className="hud__item">
        <b>{snapshot.tick}</b>
        <em>tick</em>
      </span>
      <span className="hud__item">
        <b>{engine.activeDevice}</b>
        <em>device</em>
      </span>
      {snapshot.mode === 'replay' && (
        <span className="hud__item hud__item--accent">
          <b>{(snapshot.replayProgress * 100).toFixed(0)}%</b>
          <em>replay</em>
        </span>
      )}
      {snapshot.recording && (
        <span className="hud__item hud__item--recording">
          <b>REC</b>
          <em>recording</em>
        </span>
      )}
    </div>
  );
}

/**
 * Unity-style dock bar: which docks are visible, plus the workspace switch.
 *
 * The Asset Library stopped being a separate screen — it is the bottom dock
 * now, the way Unity's Project window is — so "Asset Library" here means
 * "show the bottom dock" and shares the same workspaceMode state (and test
 * ids) it always had.
 */
function DockBar({
  showHierarchy,
  setShowHierarchy,
  showInspector,
  setShowInspector,
}: {
  showHierarchy: boolean;
  setShowHierarchy: (next: boolean) => void;
  showInspector: boolean;
  setShowInspector: (next: boolean) => void;
}) {
  const mode = useChamber((state) => state.workspaceMode);
  const setMode = useChamber((state) => state.setWorkspaceMode);
  const showLibrary = mode === 'asset-library';
  return (
    <nav className="workspace-switch" data-testid="workspace-switch">
      <span className="workspace-switch__title">Animation Test Chamber</span>
      <button
        type="button"
        className={showHierarchy ? 'is-active' : ''}
        onClick={() => setShowHierarchy(!showHierarchy)}
        data-testid="toggle-hierarchy"
      >
        Hierarchy
      </button>
      <button
        type="button"
        className={showInspector ? 'is-active' : ''}
        onClick={() => setShowInspector(!showInspector)}
        data-testid="toggle-inspector"
      >
        Inspector
      </button>
      <button
        type="button"
        className={showLibrary ? 'is-active' : ''}
        onClick={() => setMode(showLibrary ? 'chamber' : 'asset-library')}
        data-testid={showLibrary ? 'workspace-chamber' : 'workspace-asset-library'}
      >
        Project (Assets)
      </button>
    </nav>
  );
}

export function App() {
  const engine = useChamber((state) => state.engine);
  const activePanel = useChamber((state) => state.activePanel);
  const setPanel = useChamber((state) => state.setPanel);
  const statusMessage = useChamber((state) => state.statusMessage);
  const staleCharacterDrafts = useChamber((state) => state.staleCharacterDrafts);
  const discardStaleCharacterDraft = useChamber((state) => state.discardStaleCharacterDraft);
  const showMobilePad = useChamber((state) => state.showMobilePad);
  const toggleMobilePad = useChamber((state) => state.toggleMobilePad);
  const hideUi = useChamber((state) => state.hideUiForRecording);
  const setHideUi = useChamber((state) => state.setHideUiForRecording);
  const undo = useChamber((state) => state.undo);
  const redo = useChamber((state) => state.redo);
  const exportUnity = useChamber((state) => state.exportUnity);
  const project = useChamber((state) => state.project);
  const characterPresetId = useChamber((state) => state.characterPresetId);
  const weaponModeId = useChamber((state) => state.weaponModeId);
  const gripEditorMode = useChamber((state) => state.gripEditorMode);
  const setGripEditorMode = useChamber((state) => state.setGripEditorMode);
  const resetWeaponGrip = useChamber((state) => state.resetWeaponGrip);
  const detectBackend = useChamber((state) => state.detectBackend);
  const backendOnline = useChamber((state) => state.backendOnline);

  const workspaceMode = useChamber((state) => state.workspaceMode);
  const libraryDialog = useChamber((state) => state.libraryDialog);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [showHierarchy, setShowHierarchy] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const [padAuto] = useState(() => detectTouchDevice());
  const [mouseLookMode, setMouseLookMode] = useState<MouseLookMode>('free');
  const [paused, setPaused] = useState(() => engine.isPaused);
  const gripSupported = Boolean(
    characterPreset(characterPresetId).weaponGrips?.[weaponModeId] &&
    weaponMode(weaponModeId).heldItem,
  );

  const toggleMouseLookMode = (): void => {
    const next = mouseLookMode === 'free' ? 'drag' : 'free';
    setMouseLookMode(next);
    engine.setMouseLookMode(next);
  };

  useEffect(() => {
    void detectBackend();
  }, [detectBackend]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey)) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const padVisible =
    gripEditorMode === null &&
    (project.inputMap.mobilePad.visibility === 'always-on' ||
      (project.inputMap.mobilePad.visibility === 'auto' && padAuto) ||
      showMobilePad);

  const libraryOpen = workspaceMode === 'asset-library';
  const layout = hideUi
    ? ' app--clean'
    : `${showHierarchy ? ' app--hierarchy' : ''}${showInspector ? ' app--inspector' : ''}${
        libraryOpen ? ' app--library-dock' : ''
      }`;

  return (
    <div className={`app${layout}`}>
      {!hideUi && (
        <DockBar
          showHierarchy={showHierarchy}
          setShowHierarchy={setShowHierarchy}
          showInspector={showInspector}
          setShowInspector={setShowInspector}
        />
      )}
      {!hideUi && showHierarchy && (
        <aside className="app__hierarchy">
          <Hierarchy />
        </aside>
      )}
      <div className="app__viewport">
        <Viewport />
        {!hideUi && <Hud />}
        {padVisible && <MobilePad />}

        {!hideUi && (
          <details className="viewport-controls" data-testid="viewport-controls" open>
            <summary>Controls</summary>
            <div className="viewport-controls__body">
              {/* Character, weapon and equipment live in the Hierarchy now —
                  they are scene objects, not scene-view controls. */}
              <label className="viewport-select">
                Grip
                <select
                  value={gripEditorMode ?? 'off'}
                  disabled={!gripSupported}
                  onChange={(event) =>
                    setGripEditorMode(
                      event.target.value === 'off'
                        ? null
                        : (event.target.value as 'translate' | 'rotate'),
                    )
                  }
                  data-testid="grip-editor-select"
                >
                  <option value="off">Off</option>
                  <option value="translate">Move · autosave</option>
                  <option value="rotate">Rotate · autosave</option>
                </select>
              </label>
              {gripEditorMode && (
                <button
                  type="button"
                  onClick={() => resetWeaponGrip(characterPresetId, weaponModeId)}
                  data-testid="reset-grip"
                >
                  Reset grip
                </button>
              )}
              <button
                type="button"
                onClick={toggleMouseLookMode}
                data-testid="toggle-camera-control"
                title="Switch camera control mode"
              >
                Camera: {mouseLookMode === 'free' ? 'Mouse move' : 'Click-drag'}
              </button>
              <button
                type="button"
                onClick={toggleMobilePad}
                disabled={gripEditorMode !== null}
                data-testid="toggle-pad"
              >
                {gripEditorMode ? 'Pad paused' : padVisible ? 'Hide pad' : 'Show pad'}
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = !engine.isPaused;
                  engine.setPaused(next);
                  setPaused(next);
                }}
                data-testid="toggle-pause"
              >
                {paused ? 'Resume motion' : 'Pause motion'}
              </button>
              <button
                type="button"
                onClick={() => engine.frameStep()}
                disabled={!paused}
                data-testid="frame-step"
              >
                Frame step
              </button>
              <button type="button" onClick={() => setHideUi(true)}>
                Clean capture
              </button>
              <button
                type="button"
                onClick={exportUnity}
                disabled={backendOnline === false}
                title={
                  backendOnline === false
                    ? 'Needs the local API server — it writes the bundle to generated/unity.'
                    : 'Write a Unity bundle to generated/unity'
                }
              >
                Unity export
              </button>
            </div>
          </details>
        )}

        {hideUi && (
          <button type="button" className="restore-ui" onClick={() => setHideUi(false)}>
            Show UI
          </button>
        )}
      </div>

      {!hideUi && (
        <>
          {showInspector && (
            <button
              type="button"
              className="sheet-handle"
              onClick={() => setSheetOpen((open) => !open)}
              data-testid="sheet-handle"
            >
              {sheetOpen ? 'Close panels ▾' : 'Open panels ▴'}
            </button>
          )}

          {showInspector && (
            <aside className={`app__panels${sheetOpen ? ' is-open' : ''}`}>
              <nav className="tabs">
                {PANELS.map((panel) => (
                  <button
                    type="button"
                    key={panel.id}
                    className={activePanel === panel.id ? 'is-active' : ''}
                    onClick={() => setPanel(panel.id)}
                    data-testid={`tab-${panel.id}`}
                  >
                    {panel.label}
                  </button>
                ))}
              </nav>
              <div className="app__panel-body">
                <PanelBody id={activePanel} />
              </div>
            </aside>
          )}

          {/* Unity's Project window: the asset library docked along the bottom
              rather than a screen you leave the running simulation to visit. */}
          {libraryOpen && (
            <section className="app__library-dock">
              <AssetLibrary />
            </section>
          )}

          {/* The dialog belongs to the Chamber too: a commit that turns out to
              hold animation edits opens it here rather than sending the reader
              to another workspace to find out why the commit stopped. */}
          {libraryDialog === 'save-destination' && <SaveDestinationDialog />}

          {/* A draft made against a repository revision that has since moved
              on is never reapplied silently (PLAN Part V §24) — it is only
              ever offered here, for a human to discard. */}
          {staleCharacterDrafts.length > 0 && (
            <div className="app__stale-draft-banner" data-testid="stale-character-draft-banner">
              {staleCharacterDrafts.map((draft) => (
                <p key={`${draft.characterId}:${draft.revisionId}`}>
                  A browser-only draft for “{draft.characterId}” was made against an older
                  repository revision and was not applied.
                  <button
                    type="button"
                    onClick={() => discardStaleCharacterDraft(draft.characterId, draft.revisionId)}
                    data-testid={`stale-character-draft-discard-${draft.characterId}`}
                  >
                    Discard
                  </button>
                </p>
              ))}
            </div>
          )}

          <footer className="status" data-testid="status-bar">
            {statusMessage}
          </footer>
        </>
      )}
    </div>
  );
}
