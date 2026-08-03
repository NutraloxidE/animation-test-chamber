import { useEffect, useState } from 'react';
import { detectTouchDevice } from '@atc/input-runtime';
import { useChamber } from './store.ts';
import { Viewport } from './three/Viewport.tsx';
import { WorldViewport } from './components/world/WorldViewport.tsx';
import { MobilePad } from './panels/MobilePad.tsx';
import { SceneHierarchy } from './hierarchy/SceneHierarchy.tsx';
import { ContextualInspector } from './inspector/ContextualInspector.tsx';
import { BottomWorkspaceDock } from './workspaces/BottomWorkspaceDock.tsx';
import { SaveDestinationDialog } from './asset-library/SaveDestinationDialog.tsx';
import { characterPreset, weaponMode } from './three/catalog.ts';

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
  const presentation = useChamber((state) => state.viewportPresentation);
  const setPresentation = useChamber((state) => state.setViewportPresentation);
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
      {/* View is a presentation choice and nothing else. The old button also
          called setWorldMode *and* setPanel('world'), so asking to see the
          whole world moved the inspector off whatever you were editing. */}
      <button
        type="button"
        className={presentation === 'world' ? 'is-active' : ''}
        onClick={() =>
          setPresentation(presentation === 'world' ? 'isolate-selection' : 'world')
        }
        data-testid="toggle-world-mode"
        title="Viewport presentation. Does not change the selection or the inspector."
      >
        View: {presentation === 'world' ? 'World' : 'Isolate'}
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
  const setWorkspaceMode = useChamber((state) => state.setWorkspaceMode);
  const libraryDialog = useChamber((state) => state.libraryDialog);
  const presentation = useChamber((state) => state.viewportPresentation);
  const mouseLookMode = useChamber((state) => state.mouseLookMode);
  const setMouseLookMode = useChamber((state) => state.setMouseLookMode);

  const [sheetOpen, setSheetOpen] = useState(false);
  // Matches the 900px breakpoint styles.css uses to turn the side and bottom
  // docks from reserved columns into overlays.
  const narrow = !window.matchMedia('(min-width: 901px)').matches;
  // Below the 900px breakpoint the hierarchy dock becomes a fixed overlay
  // (styles.css) rather than a reserved grid column, so leaving it open by
  // default there would cover the sheet handle and every other narrow-width
  // control before the user ever asked for it.
  const [showHierarchy, setShowHierarchy] = useState(() => window.matchMedia('(min-width: 901px)').matches);
  const [showInspector, setShowInspector] = useState(true);
  const [padAuto] = useState(() => detectTouchDevice());
  const [paused, setPaused] = useState(() => engine.isPaused);
  const gripSupported = Boolean(
    characterPreset(characterPresetId).weaponGrips?.[weaponModeId] &&
    weaponMode(weaponModeId).heldItem,
  );

  const toggleMouseLookMode = (): void =>
    setMouseLookMode(mouseLookMode === 'free' ? 'drag' : 'free');

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
          <SceneHierarchy />
        </aside>
      )}
      <div className="app__viewport">
        {/* Presentation picks the renderer and nothing else: `world` draws
            every instance, `isolate-selection` draws one. Neither branch reads
            or writes `sceneSelection`, which is what makes switching views
            leave the inspector where it was. */}
        {presentation === 'world' ? <WorldViewport /> : <Viewport />}
        {!hideUi && <Hud />}
        {padVisible && <MobilePad />}

        {!hideUi && (
          <details className="viewport-controls" data-testid="viewport-controls" open>
            <summary>Controls</summary>
            <div className="viewport-controls__body">
              {/* Character, weapon, equipment and animation selection are
                  all gone from here. The overlay answers "how do I observe and
                  drive this view?"; it does not answer "how is this object
                  authored?" — that is the Inspector's question. */}
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
              className={`sheet-handle${sheetOpen ? ' is-raised' : ''}`}
              onClick={() => {
                const next = !sheetOpen;
                setSheetOpen(next);
                // Narrow viewports give the bottom of the screen to one
                // overlay at a time. The Inspector sheet and the workspace
                // dock both live there, and stacking them leaves whichever
                // lost the z-index race unreachable rather than merely hidden.
                if (next && narrow && libraryOpen) setWorkspaceMode('chamber');
              }}
              data-testid="sheet-handle"
            >
              {sheetOpen ? 'Close panels ▾' : 'Open panels ▴'}
            </button>
          )}

          {/* No tab strip. The right dock shows whatever is selected in the
              scene, so there is nothing here for a tab index to disagree
              with — and no `World` tab hiding the instance list behind a
              click. */}
          {showInspector && (
            <aside className={`app__panels${sheetOpen ? ' is-open' : ''}`}>
              <div className="app__panel-body">
                <ContextualInspector />
              </div>
            </aside>
          )}

          {/* Unity's Project window: the editor workspaces docked along the
              bottom rather than screens you leave the running simulation to
              visit. The Inspector stays visible while they change. */}
          {libraryOpen && <BottomWorkspaceDock />}

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
