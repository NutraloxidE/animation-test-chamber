/**
 * The world itself: what exists, what it routes to, and what is staged.
 *
 * Notably absent: per-instance transform fields. The world root used to be the
 * only selectable thing on the right, so instance properties had nowhere else
 * to go; now they have their own inspector, and putting a copy of them here
 * would recreate the ambiguity about which instance a field was editing.
 */
import { useChamber } from '../store.ts';
import { useObservations } from './observations.ts';
import { ScopeBadge } from './sections/ScopeBadge.tsx';

export function WorldInspector() {
  const world = useChamber((state) => state.stagedWorld);
  const worldDirty = useChamber((state) => state.worldDirty);
  const revertWorldEdits = useChamber((state) => state.revertWorldEdits);
  const duplicateInstance = useChamber((state) => state.duplicateSelectedInstance);
  const selectScene = useChamber((state) => state.selectScene);
  const setBottomWorkspace = useChamber((state) => state.setBottomWorkspace);
  const observation = useObservations();

  return (
    <div className="inspector inspector--world" data-testid="world-inspector">
      <header className="inspector__header">
        <h2>{world.displayName}</h2>
        <span className="inspector__tick" data-testid="world-tick">
          tick {observation.tick}
        </span>
      </header>

      <section className="inspector__section" data-testid="inspector-world-identity">
        <h3>World</h3>
        <dl className="inspector__provenance">
          <dt>World id</dt>
          <dd data-testid="world-inspector-world-id">{world.id}</dd>
          <dt>Instances</dt>
          <dd data-testid="world-inspector-instance-count">{world.instances.length}</dd>
          <dt>Staged</dt>
          <dd data-testid="world-inspector-dirty">{worldDirty ? 'unsaved edits' : 'clean'}</dd>
        </dl>
      </section>

      <section className="inspector__section" data-testid="inspector-world-routing">
        <h3>Routing</h3>
        <dl className="inspector__provenance">
          <dt>Focused instance</dt>
          <dd data-testid="world-inspector-focused">{world.focusedInstanceId}</dd>
          <dt>Camera target</dt>
          <dd data-testid="world-inspector-camera-target">{world.cameraTargetInstanceId}</dd>
        </dl>
        <p className="inspector__hint">
          Both are world-level routing, edited from the instance they name. Selecting an instance
          does not change either — selection is presentation.
        </p>
      </section>

      <section className="inspector__section" data-testid="inspector-world-tracks">
        <h3>Intent Tracks</h3>
        {world.intentTracks.length === 0 ? (
          <p className="inspector__hint">No declared tracks.</p>
        ) : (
          <ul className="inspector__list">
            {world.intentTracks.map((track) => (
              <li key={track.id}>
                <button
                  type="button"
                  data-testid={`world-track-${track.id}`}
                  onClick={() => setBottomWorkspace('timeline')}
                >
                  {track.id} — open in Timeline
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="inspector__section" data-testid="inspector-world-runtime">
        <h3>
          Runtime
          <ScopeBadge scope="RUNTIME" />
        </h3>
        <dl className="inspector__runtime">
          <dt>Tick</dt>
          <dd>{observation.tick}</dd>
          <dt>Instance order</dt>
          <dd data-testid="world-inspector-order">
            {world.instances.map((instance) => instance.id).join(' → ')}
          </dd>
        </dl>
        <p className="inspector__hint">Declaration order is tick order (DECISION 0009).</p>
      </section>

      <section className="inspector__section" data-testid="inspector-world-actions">
        <h3>Actions</h3>
        <div className="inspector__actions">
          <button
            type="button"
            data-testid="world-duplicate-focused"
            onClick={() => {
              // The world root has no instance of its own, so "duplicate" here
              // means the focused one — selected first so the action and the
              // selection cannot disagree about its target.
              selectScene({ kind: 'instance', instanceId: world.focusedInstanceId });
              duplicateInstance();
            }}
          >
            Duplicate focused instance
          </button>
          <button
            type="button"
            data-testid="world-revert"
            onClick={() => revertWorldEdits()}
            disabled={!worldDirty}
          >
            Revert staged
          </button>
        </div>
      </section>
    </div>
  );
}
