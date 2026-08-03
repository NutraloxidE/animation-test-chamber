/**
 * What the instance is doing right now.
 *
 * Every value here is observed, none is authored, and the RUNTIME badge says
 * so. An inspector that renders a live locomotion state in the same visual
 * register as an editable field invites the user to try to type into it —
 * and, worse, invites the reader to believe the world document contains it.
 */
import type { InstanceObservation } from '@atc/world-runtime';
import { ScopeBadge } from './ScopeBadge.tsx';

export function RuntimeStateSection({
  observation,
}: {
  observation: InstanceObservation | undefined;
}) {
  return (
    <section className="inspector__section" data-testid="world-runtime-state">
      <h3>
        Runtime / Debug
        <ScopeBadge scope="RUNTIME" />
      </h3>
      <dl className="inspector__runtime">
        <dt>Locomotion</dt>
        <dd data-testid="world-state-locomotion">
          {observation?.layers.locomotion?.stateId ?? '—'}
        </dd>
        <dt>Action</dt>
        <dd data-testid="world-state-action">{observation?.layers.action?.stateId ?? '—'}</dd>
        <dt>Position</dt>
        <dd data-testid="world-state-position">
          {observation
            ? `${observation.transform.position.x.toFixed(2)}, ${observation.transform.position.z.toFixed(2)}`
            : '—'}
        </dd>
        <dt>Intent</dt>
        <dd data-testid="world-state-intent">
          {observation ? Number(observation.intent.Move ?? 0).toFixed(2) : '—'}
        </dd>
        <dt>Events</dt>
        <dd data-testid="world-state-events">{observation?.events.join(', ') || '—'}</dd>
      </dl>
    </section>
  );
}
