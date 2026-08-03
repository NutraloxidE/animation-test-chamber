/**
 * What the sandbox runtime is doing, tick by tick.
 *
 * Labelled SANDBOX RUNTIME rather than left to look like the world HUD: these
 * numbers come from a simulation that is not the one the rest of the app is
 * showing, and two identical-looking readouts of two different runtimes is
 * exactly the confusion this whole split exists to remove.
 */
import type { SandboxObservation } from './AnimationSandboxEngine.ts';

export function StateSandboxObservation({
  observation,
}: {
  observation: SandboxObservation | null;
}) {
  return (
    <section className="sandbox-observation" data-testid="sandbox-observation">
      <header className="sandbox-observation__header">
        <span className="workspace__badge">SANDBOX RUNTIME</span>
      </header>
      {!observation ? (
        <p className="workspace__hint">No sandbox running.</p>
      ) : (
        <dl className="sandbox-observation__grid">
          <div>
            <dt>Tick</dt>
            <dd data-testid="sandbox-tick">{observation.tick}</dd>
          </div>
          <div>
            <dt>Locomotion State</dt>
            <dd data-testid="sandbox-locomotion-state">{observation.locomotionState}</dd>
          </div>
          <div>
            <dt>Action State</dt>
            <dd data-testid="sandbox-action-state">{observation.actionState}</dd>
          </div>
          <div>
            <dt>Normalized Time</dt>
            <dd data-testid="sandbox-normalized-time">
              {observation.locomotionNormalizedTime.toFixed(3)} /{' '}
              {observation.actionNormalizedTime.toFixed(3)}
            </dd>
          </div>
          <div>
            <dt>Position</dt>
            <dd data-testid="sandbox-position">
              {observation.position.x.toFixed(2)}, {observation.position.y.toFixed(2)},{' '}
              {observation.position.z.toFixed(2)}
            </dd>
          </div>
          <div>
            <dt>Yaw</dt>
            <dd>{observation.yawRad.toFixed(3)} rad</dd>
          </div>
          <div>
            <dt>Root Displacement</dt>
            <dd data-testid="sandbox-root-displacement">
              {observation.rootDisplacement.toFixed(3)} m
            </dd>
          </div>
          <div>
            <dt>Last Transition</dt>
            <dd data-testid="sandbox-last-transition">{observation.lastTransition ?? '—'}</dd>
          </div>
          <div>
            <dt>Semantic Events</dt>
            <dd data-testid="sandbox-events">
              {observation.events.length > 0 ? observation.events.join(', ') : '—'}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
