import { useEffect, useState } from 'react';
import { detectTouchDevice } from '@atc/input-runtime';
import { useChamber } from './store.ts';
import { WorldSceneViewport } from './viewport/WorldSceneViewport.tsx';
import { SHOW_ALL } from './viewport/visibility-filter.ts';
import { LIVE_WORLD, type ViewportSceneSource } from './viewport/viewport-scene-source.ts';
import { selectedInstanceId } from './selection/scene-selection.ts';
import type { ViewportPresentation } from './selection/asset-selection.ts';
import { MobilePad } from './panels/MobilePad.tsx';
import { SceneHierarchy } from './hierarchy/SceneHierarchy.tsx';
import { ContextualInspector } from './inspector/ContextualInspector.tsx';
import { BottomWorkspaceDock } from './workspaces/BottomWorkspaceDock.tsx';
import { PrimaryWorkspaceNav } from './navigation/PrimaryWorkspaceNav.tsx';
import { CharacterLab } from './character-lab/CharacterLab.tsx';
import { SaveDestinationDialog } from './asset-library/SaveDestinationDialog.tsx';

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
/**
 * Publishes the dock bar's height as `--dockbar-h`.
 *
 * The narrow overlays (hierarchy, and the docks below it) are fixed to the
 * viewport, so without this they start at y=0 and their first rows sit *under*
 * the bar — which outranks them deliberately, since it holds the buttons that
 * close them. A constant offset would be wrong at some width: the bar wraps to
 * two or three rows depending on how its labels fall, so it is measured.
 */
/**
 * Drives the focused chamber engine, independently of which renderer is mounted.
 *
 * This used to live inside the legacy `Viewport`'s render loop, which made the
 * focused simulation's clock a property of *which presentation happened to be
 * on screen*. That was already wrong before the viewport paths merged — in
 * World presentation the legacy viewport was not mounted, so the HUD, the
 * Timeline, the layer bar and the terrain readout all silently froze at
 * whatever tick the user left them on, and nothing said so.
 *
 * A simulation's clock does not belong to a camera. Owning it here means the
 * focused engine advances in World, Isolate and Rig alike, and switching
 * presentation is once again the display-only operation it claims to be.
 */
function useChamberClock(): void {
  const engine = useChamber((state) => state.engine);

  useEffect(() => {
    // Input is attached here for the same reason: which renderer is on screen
    // must not decide whether the keyboard reaches the simulation.
    engine.attachInput();
    let frame = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const delta = (now - last) / 1000;
      last = now;
      // While a test driver owns advancement, wall-clock deltas must not also
      // advance it — the ticks under assertion would race the frames.
      if (!engine.testDriven) engine.advance(delta);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      engine.detachInput();
    };
  }, [engine]);
}

function useDockBarHeight(): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!element) return;
    const publish = (): void => {
      document.documentElement.style.setProperty(
        '--dockbar-h',
        `${Math.round(element.getBoundingClientRect().height)}px`,
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return setElement;
}

const PRESENTATION_LABEL: Record<ViewportPresentation, string> = {
  world: 'World',
  'isolate-selection': 'Isolate',
};

/**
 * World ⇄ Isolate.
 *
 * The same renderer under two visibility filters, so cycling changes nothing
 * but what is drawn. `Rig` was a third stop here and is not any more: it is a
 * single-character authoring preview, and it now lives in Character Lab where
 * that is the job (DECISION 0014).
 */
const NEXT_PRESENTATION: Record<ViewportPresentation, ViewportPresentation> = {
  world: 'isolate-selection',
  'isolate-selection': 'world',
};

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
  const measure = useDockBarHeight();
  return (
    <nav className="workspace-switch" data-testid="workspace-switch" ref={measure}>
      <span className="workspace-switch__title">Animation Test Chamber</span>
      {/* The production stages come first, before every dock toggle: they are
          what the app is for, and the toggles are how you arrange it. */}
      <PrimaryWorkspaceNav />
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
        onClick={() => setPresentation(NEXT_PRESENTATION[presentation])}
        data-testid="toggle-world-mode"
        title="Viewport presentation. Does not change the selection or the inspector."
      >
        View: {PRESENTATION_LABEL[presentation]}
      </button>
      <button
        type="button"
        className={showLibrary ? 'is-active' : ''}
        onClick={() => setMode(showLibrary ? 'chamber' : 'asset-library')}
        data-testid={showLibrary ? 'workspace-chamber' : 'workspace-asset-library'}
        title="Show or hide the bottom editor dock."
      >
        {/* Not "Project (Assets)". The dock holds Animation, Graph, Timeline,
            Replay, Diff, AI, Import and Haptics as well, and opening the
            animation tools through a button named after one of the nine
            workspaces inside it is a label that describes its own history
            rather than what it does. */}
        Editor
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
  const gripEditorMode = useChamber((state) => state.gripEditorMode);
  const detectBackend = useChamber((state) => state.detectBackend);
  const backendOnline = useChamber((state) => state.backendOnline);

  const workspaceMode = useChamber((state) => state.workspaceMode);
  const setWorkspaceMode = useChamber((state) => state.setWorkspaceMode);
  const libraryDialog = useChamber((state) => state.libraryDialog);
  const presentation = useChamber((state) => state.viewportPresentation);
  const mouseLookMode = useChamber((state) => state.mouseLookMode);
  const setMouseLookMode = useChamber((state) => state.setMouseLookMode);
  const sceneSelection = useChamber((state) => state.sceneSelection);
  const primaryWorkspace = useChamber((state) => state.primaryWorkspace);
  const animationMode = useChamber((state) => state.animationWorkspaceMode);
  const sandboxRunning = useChamber((state) => state.sandboxEngine !== null);
  const selectedId = selectedInstanceId(sceneSelection);
  /*
   * The scene source is derived, not stored. A stored copy would be a second
   * answer to "what am I looking at", and the stale one would be the one on
   * screen — which is precisely the failure mode the old two-renderer split
   * produced.
   */
  const sceneSource: ViewportSceneSource =
    animationMode === 'state-sandbox' && sandboxRunning ? { kind: 'state-sandbox' } : LIVE_WORLD;

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
  // The focused engine's clock, owned here rather than by whichever renderer
  // happens to be mounted.
  useChamberClock();
  const [paused, setPaused] = useState(() => engine.isPaused);

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
  /*
   * Character Lab is a stage and takes the whole working area, so the world
   * layout's reserved hierarchy and inspector columns must not still be
   * claiming width — an empty 240px column beside a preview stage is width the
   * stage was supposed to get.
   */
  const inCharacterLab = primaryWorkspace === 'character-lab' && !hideUi;
  const layout = hideUi
    ? ' app--clean'
    : inCharacterLab
      ? ''
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
      {/* Character Lab is a stage, not a dock: it owns the whole working area
          while it is open. The World layout — hierarchy, world viewport,
          contextual inspector — is what the other two stages share, because
          Project's browser docks into the same bottom strip. */}
      {inCharacterLab ? (
        <main className="app__stage" data-testid="primary-stage-character-lab">
          <CharacterLab />
        </main>
      ) : (
        <>
      {!hideUi && showHierarchy && (
        <aside className="app__hierarchy">
          <SceneHierarchy />
        </aside>
      )}
      <div className="app__viewport">
        {/* World and Isolate are one renderer under two visibility filters, so
            an animation feature attached to the world engine is visible in
            both — that is what removed the "switch to World view to see the
            preview" workaround. `rig` is the focused skinned viewport, chosen
            explicitly. No branch reads or writes `sceneSelection`, which is
            what makes switching views leave the inspector where it was. */}
        <WorldSceneViewport
          source={sceneSource}
          filter={
            presentation === 'isolate-selection' && selectedId
              ? { kind: 'instance', instanceId: selectedId }
              : SHOW_ALL
          }
        />
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
              {/* The weapon-grip editor moved to Character Lab's preview
                  stage: a grip is Character/Rig attachment configuration, and
                  the gizmo that edits it only exists in the renderer that
                  stage owns. Leaving the control here would have been a
                  control pointing at nothing. */}
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

          {/* A draft made against a repository revision that has since moved
              on is never reapplied silently (PLAN Part V §24) — it is only
              ever offered here, for a human to discard. */}
        </>
      )}
        </>
      )}

      {/* Application chrome, not world chrome. The status bar, the stale-draft
          banner and the save-destination dialog report on the edit session,
          which every stage shares — so they render in every stage. Nesting
          them inside the World layout meant a Character Lab edit produced a
          status message with nowhere to appear. */}
      {!hideUi && staleCharacterDrafts.length > 0 && (
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

      {/* The dialog belongs to the edit session too: a commit that turns out
          to hold animation edits opens it wherever the user is, rather than
          sending them to another stage to find out why the commit stopped. */}
      {!hideUi && libraryDialog === 'save-destination' && <SaveDestinationDialog />}

      {!hideUi && (
        <footer className="status" data-testid="status-bar">
          {statusMessage}
        </footer>
      )}
    </div>
  );
}
