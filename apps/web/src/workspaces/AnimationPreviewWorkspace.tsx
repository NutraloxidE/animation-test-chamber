/**
 * "Play this state on that instance, now."
 *
 * Animation selection used to be one control that meant three different
 * things: try a clip temporarily, assign a motion set to a shared character
 * definition, and force a running instance into a state. They have different
 * blast radii and different lifetimes, and one `<select>` cannot express that
 * — which is how a quick look at a clip became an edit somebody found later.
 *
 * This workspace owns only the first and third. Assignment lives in
 * Project/Assets, where the SHARED badge is. Nothing here writes to a project,
 * world or asset document: the override is applied on the engine's *read*
 * side, so previewing cannot reach the fixed-step tick, and clearing it
 * restores authored behaviour exactly.
 */
import { useChamber } from '../store.ts';
import { ScopeBadge } from '../inspector/sections/ScopeBadge.tsx';
import { selectedInstanceId } from '../selection/scene-selection.ts';

export function AnimationPreviewWorkspace() {
  const world = useChamber((state) => state.stagedWorld);
  const project = useChamber((state) => state.project);
  const preview = useChamber((state) => state.animationPreview);
  const selection = useChamber((state) => state.sceneSelection);
  const setPreviewTarget = useChamber((state) => state.setPreviewTarget);
  const setPreviewSubject = useChamber((state) => state.setPreviewSubject);
  const setPreviewPlaying = useChamber((state) => state.setPreviewPlaying);
  const setPreviewLoop = useChamber((state) => state.setPreviewLoop);
  const setPreviewSpeed = useChamber((state) => state.setPreviewSpeed);
  const setPreviewNormalizedTime = useChamber((state) => state.setPreviewNormalizedTime);
  const clearAnimationPreview = useChamber((state) => state.clearAnimationPreview);

  const states = project.graph.states;
  const selectedInstance = selectedInstanceId(selection);
  const active = preview.targetInstanceId !== null && preview.stateId !== null;

  return (
    <div className="workspace workspace--animation-preview" data-testid="animation-preview">
      <header className="workspace__header">
        <h2>Animation Preview</h2>
        <ScopeBadge scope="PREVIEW" />
        {active && (
          <span className="workspace__preview-flag" data-testid="preview-flag">
            PREVIEW ACTIVE
          </span>
        )}
      </header>

      <div className="workspace__row">
        <label>
          Preview target
          <select
            value={preview.targetInstanceId ?? ''}
            data-testid="preview-target"
            onChange={(event) => setPreviewTarget(event.target.value || null)}
          >
            {/* The target is always explicit. "The selected one" would make a
                preview follow the user's clicks around the tree, which is the
                one thing a temporary override must not do. */}
            <option value="">No target</option>
            {world.instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.displayName}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          data-testid="preview-target-selected"
          disabled={selectedInstance === null}
          onClick={() => selectedInstance && setPreviewTarget(selectedInstance)}
        >
          Use selected instance
        </button>
      </div>

      <div className="workspace__row">
        <label>
          Layer
          <select
            value={preview.layer}
            data-testid="preview-layer"
            onChange={(event) =>
              setPreviewSubject(
                event.target.value as 'locomotion' | 'action',
                preview.stateId ?? '',
              )
            }
          >
            <option value="locomotion">Locomotion</option>
            <option value="action">Action</option>
          </select>
        </label>

        <label>
          State
          <select
            value={preview.stateId ?? ''}
            data-testid="preview-state"
            onChange={(event) => setPreviewSubject(preview.layer, event.target.value)}
          >
            <option value="">None</option>
            {states
              .filter((state) => state.layer === preview.layer)
              .map((state) => (
                <option key={state.id} value={state.id}>
                  {state.id}
                </option>
              ))}
          </select>
        </label>
      </div>

      <div className="workspace__row workspace__transport">
        <button
          type="button"
          data-testid="preview-play"
          disabled={!active}
          onClick={() => setPreviewPlaying(true)}
        >
          Play
        </button>
        <button
          type="button"
          data-testid="preview-pause"
          disabled={!active}
          onClick={() => setPreviewPlaying(false)}
        >
          Pause
        </button>
        <button
          type="button"
          data-testid="preview-stop"
          disabled={!active}
          onClick={() => {
            setPreviewPlaying(false);
            setPreviewNormalizedTime(0);
          }}
        >
          Stop
        </button>
        <label>
          Loop
          <input
            type="checkbox"
            checked={preview.loop}
            data-testid="preview-loop"
            onChange={(event) => setPreviewLoop(event.target.checked)}
          />
        </label>
        <label>
          Speed
          <input
            type="number"
            min={0}
            max={4}
            step={0.1}
            value={preview.speed}
            data-testid="preview-speed"
            onChange={(event) => setPreviewSpeed(Number(event.target.value))}
          />
        </label>
        <label>
          Normalized time
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={preview.normalizedTime}
            data-testid="preview-normalized-time"
            onChange={(event) => setPreviewNormalizedTime(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="workspace__row">
        <button
          type="button"
          className="workspace__clear"
          data-testid="preview-clear"
          disabled={!active}
          onClick={() => clearAnimationPreview()}
        >
          Clear preview override
        </button>
        <p className="workspace__hint">
          Preview never writes to the project, the world or any asset. Leaving this workspace
          commits nothing; clearing restores authored behaviour.
        </p>
      </div>
    </div>
  );
}
