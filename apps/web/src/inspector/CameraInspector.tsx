/**
 * The camera as a scene object.
 *
 * The distinction this panel exists to draw: the *authored* camera target is a
 * world property that survives a reload, while moving the view around with the
 * mouse is transient and belongs to nobody. Both used to be spelled "the
 * camera", which is why "I set the camera and it went back" was a reasonable
 * thing for a user to say.
 */
import { useChamber } from '../store.ts';
import { ScopeBadge } from './sections/ScopeBadge.tsx';

export function CameraInspector() {
  const world = useChamber((state) => state.stagedWorld);
  const mouseLookMode = useChamber((state) => state.mouseLookMode);
  const setMouseLookMode = useChamber((state) => state.setMouseLookMode);
  const selectScene = useChamber((state) => state.selectScene);
  const setCameraTargetInstance = useChamber((state) => state.setCameraTargetInstance);
  // Disabled instances are omitted rather than shown greyed: the store rejects
  // them anyway, and an option that always fails is worse than no option.
  const targets = world.instances.filter((instance) => instance.enabled);

  return (
    <div className="inspector inspector--camera" data-testid="camera-inspector">
      <header className="inspector__header">
        <h2>Camera</h2>
      </header>

      <section className="inspector__section" data-testid="inspector-camera-target">
        <h3>
          Target
          <ScopeBadge scope="SHARED" />
        </h3>
        <label className="inspector__field">
          <span className="inspector__field-label">Follows</span>
          <select
            value={world.cameraTargetInstanceId}
            data-testid="camera-target-instance"
            onChange={(event) => setCameraTargetInstance(event.target.value)}
          >
            {targets.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.displayName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="camera-select-target"
          onClick={() =>
            selectScene({ kind: 'instance', instanceId: world.cameraTargetInstanceId })
          }
        >
          Select target instance
        </button>
        <p className="inspector__hint">
          Also settable from the target instance&rsquo;s World Roles. The camera follows the
          authored target; which object is <em>selected</em> does not move it.
        </p>
      </section>

      <section className="inspector__section" data-testid="inspector-camera-control">
        <h3>
          Control mode
          <ScopeBadge scope="PREVIEW" />
        </h3>
        <label className="inspector__field">
          <span className="inspector__field-label">Mouse look</span>
          <select
            value={mouseLookMode}
            data-testid="camera-control-mode"
            onChange={(event) => setMouseLookMode(event.target.value as 'free' | 'drag')}
          >
            <option value="free">Mouse move</option>
            <option value="drag">Click-drag</option>
          </select>
        </label>
        <p className="inspector__hint">
          Transient viewport movement. Nothing here is written to the world document.
        </p>
      </section>
    </div>
  );
}
