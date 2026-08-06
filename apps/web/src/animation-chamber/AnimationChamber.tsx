/**
 * The native animation workspace shell.
 *
 * The donor's `App.tsx` is the layout this reproduces: a header naming what is
 * being edited, a tab strip in the donor's order, and a panel body. What it
 * does not reproduce is the donor's *source* — every panel below reads the
 * subject-scoped facade, so the workspace edits an exact Prefab node Animator
 * and nothing about a Character reaches it.
 *
 * This is the first vertical slice. Inspector, Graph, Timeline and Timing are
 * wired; the remaining tabs are registered, visible, and render the reason they
 * are not yet available rather than disappearing (§2). Viewport, HUD, Asset
 * Library dock and the redesigned Hierarchy arrive in their own phases — this
 * file is the shell they mount into.
 */
import { useEffect, useState } from 'react';
import { TransitionInspector } from '../panels/TransitionInspector.tsx';
import { StateGraph } from '../panels/StateGraph.tsx';
import { Timeline } from '../panels/Timeline.tsx';
import { MotionTimingPanel } from '../panels/MotionTimingPanel.tsx';
import { ANIMATION_PANELS } from './AnimationPanelRegistry.ts';
import type { AnimationPanelId } from './AnimationChamberFacade.ts';
import { useAnimationChamber } from './useAnimationChamber.ts';
import { isIdleLivePreview } from './AnimationLivePreview.ts';
import { presentationAvailability } from './AnimationChamberDocument.ts';
import { useAnimationPreviewClock } from './useAnimationPreviewClock.ts';

function PanelBody({ id }: { id: AnimationPanelId }): JSX.Element {
  switch (id) {
    case 'inspector':
      return <TransitionInspector />;
    case 'graph':
      return <StateGraph />;
    case 'timeline':
      return <Timeline />;
    case 'timing':
      return <MotionTimingPanel />;
    default:
      return <PanelNotYetNative id={id} />;
  }
}

/**
 * A registered panel that has not been rewired yet.
 *
 * Deliberately not an empty div: §2 forbids hiding a panel that cannot operate,
 * and the honest thing to show is which subject it would have operated on and
 * what is missing.
 */
function PanelNotYetNative({ id }: { id: AnimationPanelId }): JSX.Element {
  return (
    <section className="empty-state" data-testid={`animation-panel-pending-${id}`}>
      <h3>Not yet on the native subject</h3>
      <p>
        This panel is registered and its component is preserved, but it still reads the legacy
        Character-bound chamber. It is shown rather than hidden so its absence is a fact you can
        see instead of a tab that silently disappeared.
      </p>
    </section>
  );
}

/** Names the exact subject being authored (§8.3). */
function SubjectHeader(): JSX.Element {
  const subject = useAnimationChamber((state) => state.subject);
  const document = useAnimationChamber((state) => state.project);
  const presentation = presentationAvailability(document);
  const { prefab, nodeId, componentId } = subject.source;
  return (
    <header className="animation-subject-header" data-testid="animation-subject-header">
      <h2>{subject.displayName}</h2>
      <dl>
        <div>
          <dt>Prefab</dt>
          <dd data-testid="animation-subject-prefab">
            <code>
              {prefab.assetId}@{prefab.version}
            </code>
          </dd>
        </div>
        <div>
          <dt>Node</dt>
          <dd data-testid="animation-subject-node">
            <code>{nodeId}</code>
          </dd>
        </div>
        <div>
          <dt>Animator</dt>
          <dd data-testid="animation-subject-component">
            <code>{componentId}</code>
          </dd>
        </div>
      </dl>
      {!presentation.available && (
        <p className="muted" data-testid="animation-subject-presentation-unavailable">
          {presentation.reason}
        </p>
      )}
    </header>
  );
}

/**
 * Live readout of what the preview is doing, in the donor's terms.
 *
 * Subscribes to the engine rather than to the store: the simulation advances
 * every frame and React must not re-render the workspace at that rate, so the
 * HUD holds its own snapshot and nothing above it re-renders when a tick lands.
 */
function Hud(): JSX.Element {
  const engine = useAnimationChamber((state) => state.engine);
  const [snapshot, setSnapshot] = useState(() => engine.snapshot());

  useEffect(() => {
    setSnapshot(engine.snapshot());
    return engine.subscribe(() => setSnapshot(engine.snapshot()));
  }, [engine]);

  return (
    <dl className="hud" data-testid="hud">
      <div>
        <dt>Locomotion</dt>
        <dd data-testid="hud-locomotion">{snapshot.locomotionState || '—'}</dd>
      </div>
      <div>
        <dt>Action</dt>
        <dd data-testid="hud-action">{snapshot.actionState || '—'}</dd>
      </div>
      <div>
        <dt>Terrain</dt>
        <dd data-testid="hud-terrain">{snapshot.terrainState || '—'}</dd>
      </div>
      <div>
        <dt>Speed</dt>
        <dd data-testid="hud-speed">{snapshot.speed.toFixed(2)}</dd>
      </div>
      <div>
        <dt>Blend</dt>
        <dd data-testid="hud-blend">{snapshot.blendWeight.toFixed(2)}</dd>
      </div>
      <div>
        <dt>Tick</dt>
        <dd data-testid="hud-tick">{snapshot.tick}</dd>
      </div>
    </dl>
  );
}

/** Pause, frame-step, slow motion and reset, preserved from the donor. */
function PreviewControls(): JSX.Element | null {
  const controls = useAnimationChamber((state) => state.controls);
  const [paused, setPaused] = useState(() => controls?.isPaused ?? false);
  const [slow, setSlow] = useState(false);
  if (!controls) return null;

  return (
    <div className="viewport-controls" data-testid="viewport-controls">
      <button
        type="button"
        data-testid="toggle-pause"
        aria-pressed={paused}
        onClick={() => {
          const next = !paused;
          controls.setPaused(next);
          setPaused(next);
        }}
      >
        {paused ? 'Resume' : 'Pause'}
      </button>
      <button
        type="button"
        data-testid="frame-step"
        // Frame-step is only meaningful while paused; the donor disabled it too.
        disabled={!paused}
        onClick={() => controls.frameStep()}
      >
        Frame step
      </button>
      <button
        type="button"
        data-testid="toggle-slow-motion"
        aria-pressed={slow}
        onClick={() => {
          const next = !slow;
          controls.setTimeScale(next ? 0.25 : 1);
          setSlow(next);
        }}
      >
        {slow ? 'Normal speed' : 'Slow motion'}
      </button>
      <button
        type="button"
        data-testid="reset-preview"
        onClick={() => {
          controls.reset();
          controls.setPaused(paused);
        }}
      >
        Reset
      </button>
    </div>
  );
}

export function AnimationChamber(): JSX.Element {
  const activePanel = useAnimationChamber((state) => state.activePanel);
  const setPanel = useAnimationChamber((state) => state.setPanel);
  const engine = useAnimationChamber((state) => state.engine);
  const controls = useAnimationChamber((state) => state.controls);
  const statusMessage = useAnimationChamber((state) => state.statusMessage);

  // The shell drives the simulation until a viewport exists to drive it.
  useAnimationPreviewClock(controls);

  return (
    <div className="animation-chamber" data-testid="animation-chamber">
      <SubjectHeader />

      {isIdleLivePreview(engine) ? (
        <p className="muted" data-testid="animation-preview-idle">
          {engine.idleReason.reason}
        </p>
      ) : (
        <>
          <Hud />
          <PreviewControls />
        </>
      )}

      <nav className="panel-tabs" data-testid="animation-panel-tabs">
        {ANIMATION_PANELS.map((panel) => (
          <button
            type="button"
            key={panel.id}
            className={panel.id === activePanel ? 'is-active' : ''}
            data-testid={`animation-panel-tab-${panel.id}`}
            data-implemented={panel.implemented ? 'true' : 'false'}
            aria-pressed={panel.id === activePanel}
            onClick={() => setPanel(panel.id)}
          >
            {panel.label}
          </button>
        ))}
      </nav>

      <div className="panel-body" data-testid="animation-panel-body">
        <PanelBody id={activePanel} />
      </div>

      {statusMessage !== '' && (
        <p className="status-bar" data-testid="animation-status-bar">
          {statusMessage}
        </p>
      )}
    </div>
  );
}
