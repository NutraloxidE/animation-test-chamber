/**
 * Everything one runtime instance is configured to be.
 *
 * The sections are ordered by how much of the world they can affect, closest
 * first: identity, then this instance's transform and loadout, then its world
 * roles, then the definitions it shares with everything else, then what it is
 * doing right now. Reading top to bottom, the blast radius only ever widens —
 * which is the property the old panel lacked when a shield checkbox sat two
 * pixels from a shared asset reference.
 */
import { useChamber } from '../store.ts';
import { useObservations } from './observations.ts';
import { DeclaredField, INSTANCE_SURFACE } from './sections/DeclaredFields.tsx';
import { LoadoutSection } from './sections/LoadoutSection.tsx';
import { RuntimeStateSection } from './sections/RuntimeStateSection.tsx';
import { SharedDefinitionsSection } from './sections/SharedDefinitionsSection.tsx';
import { ScopeBadge } from './sections/ScopeBadge.tsx';

/*
 * Split by field, not by a second list: every declared field is still rendered
 * exactly once, so a field added to the manifest still shows up somewhere
 * rather than silently belonging to neither section.
 */
const IDENTITY_FIELD_IDS = ['instance.character'];
const IDENTITY_FIELDS = INSTANCE_SURFACE.fields.filter((field) =>
  IDENTITY_FIELD_IDS.includes(field.id),
);
const TRANSFORM_FIELDS = INSTANCE_SURFACE.fields.filter(
  (field) => !IDENTITY_FIELD_IDS.includes(field.id),
);

export function InstanceInspector({ instanceId }: { instanceId: string }) {
  const world = useChamber((state) => state.stagedWorld);
  const setFocusedInstance = useChamber((state) => state.setFocusedInstance);
  const setCameraTargetInstance = useChamber((state) => state.setCameraTargetInstance);
  const duplicateInstance = useChamber((state) => state.duplicateSelectedInstance);
  const removeInstance = useChamber((state) => state.removeSelectedInstance);

  const observation = useObservations();
  const instance = world.instances.find((entry) => entry.id === instanceId);
  const observed = observation.instances.find((entry) => entry.instanceId === instanceId);

  if (!instance) {
    return (
      <p className="inspector__empty" data-testid="inspector-missing-instance">
        That instance is no longer in the world.
      </p>
    );
  }

  return (
    <div className="inspector inspector--instance" data-testid="instance-inspector">
      <header className="inspector__header">
        <h2>{instance.displayName}</h2>
        <ScopeBadge scope="INSTANCE" />
      </header>

      <section className="inspector__section" data-testid="inspector-identity">
        <h3>Identity</h3>
        <dl className="inspector__provenance">
          <dt>Instance id</dt>
          <dd data-testid="world-inspector-id">{instance.id}</dd>
          <dt>Display name</dt>
          <dd>{instance.displayName}</dd>
        </dl>
        {/* Which character this instance *is* belongs to identity, not to
            "Transform & Activation" — it is the one field here that changes
            what you are looking at rather than where it stands. */}
        {IDENTITY_FIELDS.map((field) => (
          <DeclaredField
            key={field.id}
            field={field}
            instanceId={instance.id}
            observations={observed}
          />
        ))}
      </section>

      <section className="inspector__section" data-testid="inspector-transform">
        <h3>Transform &amp; Activation</h3>
        {TRANSFORM_FIELDS.map((field) => (
          <DeclaredField
            key={field.id}
            field={field}
            instanceId={instance.id}
            observations={observed}
          />
        ))}
      </section>

      <LoadoutSection instanceId={instance.id} />

      <section className="inspector__section" data-testid="inspector-world-roles">
        <h3>World Roles</h3>
        <div className="inspector__actions">
          <button
            type="button"
            data-testid="world-focus"
            onClick={() => setFocusedInstance(instance.id)}
            disabled={instance.id === world.focusedInstanceId}
          >
            {instance.id === world.focusedInstanceId ? 'Focused instance' : 'Make focused instance'}
          </button>
          <button
            type="button"
            data-testid="world-camera-target"
            onClick={() => setCameraTargetInstance(instance.id)}
            disabled={instance.id === world.cameraTargetInstanceId}
          >
            {instance.id === world.cameraTargetInstanceId ? 'Camera target' : 'Make camera target'}
          </button>
          <button type="button" data-testid="world-duplicate" onClick={() => duplicateInstance()}>
            Duplicate instance
          </button>
          <button type="button" data-testid="world-remove" onClick={() => removeInstance()}>
            Remove instance
          </button>
        </div>
      </section>

      <SharedDefinitionsSection instanceId={instance.id} />
      <RuntimeStateSection observation={observed} />
    </div>
  );
}
