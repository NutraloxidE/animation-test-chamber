/**
 * The human authoring surface for the multi-instance world.
 *
 * The controls in the "Instance" section are rendered from the capability's
 * `AuthoringSurfaceDeclaration` — labels, ranges and step sizes come from the
 * manifest, and each control dispatches the `commandId` the manifest names.
 * That is what makes "a declared field with a missing command fails the
 * harness" a statement about this panel rather than about a document nobody
 * reads. It is not a generic property editor and does not try to become one.
 *
 * Every operation goes through the same typed commands the API exposes, so the
 * human path and the machine path cannot drift: there is no second way to move
 * an instance.
 */
import { useEffect, useState } from 'react';
import type { AuthoringFieldDeclaration } from '@atc/capability-runtime';
import { WORLD_CAPABILITY } from '@atc/capability-runtime';
import type { InstanceObservation } from '@atc/world-runtime';
import { useChamber } from '../../store.ts';

const SURFACE = WORLD_CAPABILITY.authoringSurfaces.find(
  (surface) => surface.id === 'world.instance-inspector',
)!;

/** Live observations, sampled off the simulation's critical path. */
function useObservations() {
  const engine = useChamber((state) => state.worldEngine);
  const [observation, setObservation] = useState(() => engine.observe());
  useEffect(() => {
    const interval = window.setInterval(() => setObservation(engine.observe()), 120);
    return () => window.clearInterval(interval);
  }, [engine]);
  return observation;
}

function InstanceList({ observations }: { observations: InstanceObservation[] }) {
  const world = useChamber((state) => state.stagedWorld);
  const selectedInstanceId = useChamber((state) => state.selectedInstanceId);
  const selectInstance = useChamber((state) => state.selectInstance);

  return (
    <ul className="world-panel__list" data-testid="world-instance-list">
      {world.instances.map((instance) => {
        const observation = observations.find((entry) => entry.instanceId === instance.id);
        return (
          <li key={instance.id}>
            <button
              type="button"
              className={
                instance.id === selectedInstanceId
                  ? 'world-panel__instance world-panel__instance--selected'
                  : 'world-panel__instance'
              }
              data-testid={`world-instance-${instance.id}`}
              data-selected={instance.id === selectedInstanceId}
              onClick={() => selectInstance(instance.id)}
            >
              <span className="world-panel__instance-name">{instance.displayName}</span>
              <span className="world-panel__instance-meta">
                {instance.intentSource.kind}
                {instance.enabled ? '' : ' · disabled'}
              </span>
              <span className="world-panel__instance-state">
                {observation?.layers.locomotion?.stateId ?? '—'}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One declared field, rendered by its declared control kind. */
function DeclaredField({
  field,
  instanceId,
  observations,
}: {
  field: AuthoringFieldDeclaration;
  instanceId: string;
  observations: InstanceObservation | undefined;
}) {
  const world = useChamber((state) => state.stagedWorld);
  const runWorldCommand = useChamber((state) => state.runWorldCommand);
  const instance = world.instances.find((entry) => entry.id === instanceId);
  if (!instance) return null;

  const scopeBadge = (
    <span
      className={`world-panel__scope world-panel__scope--${field.scope}`}
      title={
        field.scope === 'instance'
          ? 'Instance-scoped: changing this affects only the selected instance.'
          : 'Shared definition: changing this affects every instance referencing it.'
      }
    >
      {field.scope === 'instance' ? 'instance' : 'shared'}
    </span>
  );

  const observed = observations
    ? field.observationIds
        .map((id) => describeObservation(id, observations))
        .filter((text) => text !== '')
        .join('  ')
    : '';

  return (
    <label className="world-panel__field" data-testid={`world-field-${field.id}`}>
      <span className="world-panel__field-label">
        {field.label}
        {scopeBadge}
      </span>

      {field.control.kind === 'boolean' && (
        <input
          type="checkbox"
          checked={instance.enabled}
          data-testid={`world-field-${field.id}-input`}
          onChange={(event) =>
            runWorldCommand(field.commandId, {
              instanceId,
              enabled: event.target.checked,
            })
          }
        />
      )}

      {field.control.kind === 'vector3' && (
        <span className="world-panel__vector">
          {(['x', 'y', 'z'] as const).map((axis) => (
            <input
              key={axis}
              type="number"
              min={field.control.kind === 'vector3' ? field.control.min : undefined}
              max={field.control.kind === 'vector3' ? field.control.max : undefined}
              step={field.control.kind === 'vector3' ? field.control.step : undefined}
              value={instance.transform.position[axis]}
              data-testid={`world-field-${field.id}-${axis}`}
              onChange={(event) =>
                runWorldCommand(field.commandId, {
                  instanceId,
                  position: {
                    ...instance.transform.position,
                    [axis]: Number(event.target.value),
                  },
                  yawRad: instance.transform.yawRad,
                })
              }
            />
          ))}
        </span>
      )}

      {field.control.kind === 'number' && (
        <input
          type="number"
          min={field.control.min}
          max={field.control.max}
          step={field.control.step}
          value={instance.transform.yawRad}
          data-testid={`world-field-${field.id}-input`}
          onChange={(event) =>
            runWorldCommand(field.commandId, {
              instanceId,
              position: { ...instance.transform.position },
              yawRad: Number(event.target.value),
            })
          }
        />
      )}

      {field.control.kind === 'enum' && (
        <select
          value={instance.intentSource.kind}
          data-testid={`world-field-${field.id}-input`}
          onChange={(event) =>
            runWorldCommand(field.commandId, {
              instanceId,
              intentSource: intentSourceFor(event.target.value, world.intentTracks[0]?.id),
            })
          }
        >
          {field.control.values.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      )}

      {observed && <span className="world-panel__observed">{observed}</span>}
      {field.description && <span className="world-panel__hint">{field.description}</span>}
    </label>
  );
}

function intentSourceFor(kind: string, firstTrackId: string | undefined) {
  switch (kind) {
    case 'local-input':
      return { kind: 'local-input', playerIndex: 0 };
    case 'scripted-track':
      // The first declared track is the only one that can be bound without
      // asking; a picker for the rest belongs to the track surface, not here.
      return { kind: 'scripted-track', trackId: firstTrackId ?? '' };
    case 'replay':
      return { kind: 'replay', replayId: '' };
    default:
      return { kind: 'none' };
  }
}

function describeObservation(id: string, observation: InstanceObservation): string {
  switch (id) {
    case 'world.instance.enabled':
      return observation.enabled ? 'ticking' : 'not ticking';
    case 'world.instance.transform':
      return `x ${observation.transform.position.x.toFixed(2)} z ${observation.transform.position.z.toFixed(2)}`;
    case 'world.instance.intentSource':
      return observation.intentSourceBinding;
    case 'world.instance.intent':
      return `move ${Number(observation.intent.Move ?? 0).toFixed(2)}`;
    default:
      return '';
  }
}

export function WorldPanel() {
  const world = useChamber((state) => state.stagedWorld);
  const selectedInstanceId = useChamber((state) => state.selectedInstanceId);
  const duplicateInstance = useChamber((state) => state.duplicateSelectedInstance);
  const setFocusedInstance = useChamber((state) => state.setFocusedInstance);
  const setCameraTargetInstance = useChamber((state) => state.setCameraTargetInstance);
  const revertWorldEdits = useChamber((state) => state.revertWorldEdits);
  const worldMessage = useChamber((state) => state.worldMessage);
  const worldDirty = useChamber((state) => state.worldDirty);
  const sharedAssets = useChamber((state) => state.sharedAssetsFor(state.selectedInstanceId));

  const observation = useObservations();
  const selected = observation.instances.find((entry) => entry.instanceId === selectedInstanceId);
  const instance = world.instances.find((entry) => entry.id === selectedInstanceId);

  return (
    <div className="world-panel" data-testid="world-panel">
      <header className="world-panel__header">
        <h2>{world.displayName}</h2>
        <span className="world-panel__tick" data-testid="world-tick">
          tick {observation.tick}
        </span>
      </header>

      <InstanceList observations={observation.instances} />

      <div className="world-panel__actions">
        <button
          type="button"
          data-testid="world-duplicate"
          onClick={() => duplicateInstance()}
          disabled={!selectedInstanceId}
        >
          Duplicate instance
        </button>
        <button
          type="button"
          data-testid="world-focus"
          onClick={() => setFocusedInstance(selectedInstanceId)}
          disabled={!selectedInstanceId}
        >
          Focus
        </button>
        <button
          type="button"
          data-testid="world-camera-target"
          onClick={() => setCameraTargetInstance(selectedInstanceId)}
          disabled={!selectedInstanceId}
        >
          Camera target
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

      {instance && (
        <section className="world-panel__inspector" data-testid="world-inspector">
          <h3>{SURFACE.title}</h3>
          <dl className="world-panel__provenance">
            <dt>Instance id</dt>
            <dd data-testid="world-inspector-id">{instance.id}</dd>
            <dt>Source character</dt>
            <dd data-testid="world-inspector-character">{instance.source.characterId}</dd>
            <dt>Behaviour</dt>
            <dd data-testid="world-inspector-behavior">
              {sharedAssets ? `${sharedAssets.behavior.assetId}@${sharedAssets.behavior.version}` : '—'}
            </dd>
            <dt>Motion set</dt>
            <dd>
              {sharedAssets ? `${sharedAssets.motionSet.assetId}@${sharedAssets.motionSet.version}` : '—'}
            </dd>
            <dt>Rig</dt>
            <dd>{sharedAssets ? `${sharedAssets.rig.assetId}@${sharedAssets.rig.version}` : '—'}</dd>
          </dl>

          <p className="world-panel__sharing">
            These assets are <b>shared</b>: tuning them changes every instance referencing this
            character. Everything below is <b>this instance only</b>.
          </p>

          {SURFACE.fields.map((field) => (
            <DeclaredField
              key={field.id}
              field={field}
              instanceId={instance.id}
              observations={selected}
            />
          ))}

          <dl className="world-panel__runtime" data-testid="world-runtime-state">
            <dt>Locomotion</dt>
            <dd data-testid="world-state-locomotion">{selected?.layers.locomotion?.stateId ?? '—'}</dd>
            <dt>Action</dt>
            <dd data-testid="world-state-action">{selected?.layers.action?.stateId ?? '—'}</dd>
            <dt>Position</dt>
            <dd data-testid="world-state-position">
              {selected
                ? `${selected.transform.position.x.toFixed(2)}, ${selected.transform.position.z.toFixed(2)}`
                : '—'}
            </dd>
            <dt>Intent</dt>
            <dd data-testid="world-state-intent">
              {selected ? Number(selected.intent.Move ?? 0).toFixed(2) : '—'}
            </dd>
            <dt>Events</dt>
            <dd data-testid="world-state-events">{selected?.events.join(', ') || '—'}</dd>
          </dl>
        </section>
      )}

      {worldMessage && (
        <p className="world-panel__message" data-testid="world-message">
          {worldMessage}
        </p>
      )}
    </div>
  );
}
