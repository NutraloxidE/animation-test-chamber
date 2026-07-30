import { useEffect, useState } from 'react';
import { detectTouchDevice } from '@atc/input-runtime';
import { useChamber, type PanelId } from './store.ts';
import { Viewport } from './three/Viewport.tsx';
import { TransitionInspector } from './panels/TransitionInspector.tsx';
import { StateGraph } from './panels/StateGraph.tsx';
import { Timeline } from './panels/Timeline.tsx';
import { ReplayPanel } from './panels/ReplayPanel.tsx';
import { DiffPanel } from './panels/DiffPanel.tsx';
import { AiPanel } from './panels/AiPanel.tsx';
import { CapabilityPanel } from './panels/CapabilityPanel.tsx';
import { TerrainPanel } from './panels/TerrainPanel.tsx';
import { AcquisitionPanel } from './panels/AcquisitionPanel.tsx';
import { MobilePad } from './panels/MobilePad.tsx';
import type { MouseLookMode } from '@atc/input-runtime';
import { CHARACTER_PRESETS, MOTION_SETS } from './three/catalog.ts';

const PANELS: { id: PanelId; label: string }[] = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'graph', label: 'Graph' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'replay', label: 'Replay' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'ai', label: 'AI' },
  { id: 'diff', label: 'Diff' },
  { id: 'capability', label: 'Haptics' },
  { id: 'acquisition', label: 'Assets' },
];

function PanelBody({ id }: { id: PanelId }) {
  switch (id) {
    case 'inspector':
      return <TransitionInspector />;
    case 'graph':
      return <StateGraph />;
    case 'timeline':
      return <Timeline />;
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

export function App() {
  const engine = useChamber((state) => state.engine);
  const activePanel = useChamber((state) => state.activePanel);
  const setPanel = useChamber((state) => state.setPanel);
  const statusMessage = useChamber((state) => state.statusMessage);
  const showMobilePad = useChamber((state) => state.showMobilePad);
  const toggleMobilePad = useChamber((state) => state.toggleMobilePad);
  const hideUi = useChamber((state) => state.hideUiForRecording);
  const setHideUi = useChamber((state) => state.setHideUiForRecording);
  const undo = useChamber((state) => state.undo);
  const redo = useChamber((state) => state.redo);
  const exportUnity = useChamber((state) => state.exportUnity);
  const project = useChamber((state) => state.project);
  const characterPresetId = useChamber((state) => state.characterPresetId);
  const motionSetId = useChamber((state) => state.motionSetId);
  const setCharacterPreset = useChamber((state) => state.setCharacterPreset);
  const setMotionSet = useChamber((state) => state.setMotionSet);
  const detectBackend = useChamber((state) => state.detectBackend);
  const backendOnline = useChamber((state) => state.backendOnline);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [padAuto] = useState(() => detectTouchDevice());
  const [mouseLookMode, setMouseLookMode] = useState<MouseLookMode>('free');

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
    project.inputMap.mobilePad.visibility === 'always-on' ||
    (project.inputMap.mobilePad.visibility === 'auto' && padAuto) ||
    showMobilePad;

  return (
    <div className={`app${hideUi ? ' app--clean' : ''}`}>
      <div className="app__viewport">
        <Viewport />
        {!hideUi && <Hud />}
        {padVisible && <MobilePad />}

        {!hideUi && (
          <div className="viewport-controls">
            <label className="viewport-select">
              Character
              <select value={characterPresetId} onChange={(event) => setCharacterPreset(event.target.value)} data-testid="character-select">
                {CHARACTER_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              </select>
            </label>
            <label className="viewport-select">
              Motion
              <select value={motionSetId} onChange={(event) => setMotionSet(event.target.value)} data-testid="motion-set-select">
                {MOTION_SETS.map((set) => <option key={set.id} value={set.id}>{set.label}</option>)}
              </select>
            </label>
            <button
              type="button"
              onClick={toggleMouseLookMode}
              data-testid="toggle-camera-control"
              title="Switch camera control mode"
            >
              Camera: {mouseLookMode === 'free' ? 'Mouse move' : 'Click-drag'}
            </button>
            <button type="button" onClick={toggleMobilePad} data-testid="toggle-pad">
              {padVisible ? 'Hide pad' : 'Show pad'}
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
        )}

        {hideUi && (
          <button type="button" className="restore-ui" onClick={() => setHideUi(false)}>
            Show UI
          </button>
        )}
      </div>

      {!hideUi && (
        <>
          <button
            type="button"
            className="sheet-handle"
            onClick={() => setSheetOpen((open) => !open)}
            data-testid="sheet-handle"
          >
            {sheetOpen ? 'Close panels ▾' : 'Open panels ▴'}
          </button>

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

          <footer className="status" data-testid="status-bar">
            {statusMessage}
          </footer>
        </>
      )}
    </div>
  );
}
