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
import { CHARACTER_PRESETS } from '../three/catalog.ts';
import { useObservations } from './observations.ts';
import { DeclaredField, INSTANCE_SURFACE } from './sections/DeclaredFields.tsx';
import { LoadoutSection } from './sections/LoadoutSection.tsx';
import { RuntimeStateSection } from './sections/RuntimeStateSection.tsx';
import { SharedDefinitionsSection } from './sections/SharedDefinitionsSection.tsx';
import { ScopeBadge } from './sections/ScopeBadge.tsx';

/**
 * Which model draws this instance.
 *
 * Instance-scoped, and sits above Shared Definitions so the panel's ordering
 * still holds: this changes one instance's appearance and nothing else. The
 * explicit "Default" option matters — without it, picking the model that
 * happens to be the current default would pin the instance to it forever,
 * and the user would have no way to tell the two states apart.
 */
function RenderModelSection({ instanceId }: { instanceId: string }) {
  const override = useChamber((state) => state.instanceCharacterPresets[instanceId]);
  const defaultId = useChamber((state) => state.characterPresetId);
  const setInstanceCharacterPreset = useChamber((state) => state.setInstanceCharacterPreset);
  const defaultLabel = CHARACTER_PRESETS.find((preset) => preset.id === defaultId)?.label;

  return (
    <section className="inspector__section" data-testid="inspector-render-model">
      <h3>
        Render Model
        <ScopeBadge scope="INSTANCE" />
      </h3>
      <label className="inspector__field">
        <span className="inspector__field-label">Model</span>
        <select
          value={override ?? ''}
          data-testid="instance-character-select"
          onChange={(event) =>
            setInstanceCharacterPreset(instanceId, event.target.value || null)
          }
        >
          <option value="">Default ({defaultLabel})</option>
          {CHARACTER_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <p className="inspector__hint">
        Presentation only. Nothing here changes the animation this instance plays, and nothing is
        written to the world document.
      </p>
    </section>
  );
}

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
      </section>

      <section className="inspector__section" data-testid="inspector-transform">
        <h3>Transform &amp; Activation</h3>
        {INSTANCE_SURFACE.fields.map((field) => (
          <DeclaredField
            key={field.id}
            field={field}
            instanceId={instance.id}
            observations={observed}
          />
        ))}
      </section>

      <LoadoutSection instanceId={instance.id} />

      <RenderModelSection instanceId={instance.id} />

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
