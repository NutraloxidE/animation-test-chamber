/**
 * The manifest-driven part of the Instance Inspector.
 *
 * Labels, ranges and step sizes come from the capability's
 * `AuthoringSurfaceDeclaration`, and each control dispatches the `commandId`
 * the manifest names. That is what makes "a declared field with a missing
 * command fails the harness" a statement about this file rather than about a
 * document nobody reads. It moved here from `WorldPanel` unchanged in
 * behaviour: the panel was split up, the manifest contract was not loosened.
 *
 * It is not a generic property editor and does not try to become one.
 */
import type { AuthoringFieldDeclaration } from '@atc/capability-runtime';
import { WORLD_CAPABILITY } from '@atc/capability-runtime';
import type { InstanceObservation } from '@atc/world-runtime';
import { useChamber } from '../../store.ts';
import { ScopeBadge } from './ScopeBadge.tsx';

export const INSTANCE_SURFACE = WORLD_CAPABILITY.authoringSurfaces.find(
  (surface) => surface.id === 'world.instance-inspector',
)!;

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

export function describeObservation(id: string, observation: InstanceObservation): string {
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

/** One declared field, rendered by its declared control kind. */
export function DeclaredField({
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

  const observed = observations
    ? field.observationIds
        .map((id) => describeObservation(id, observations))
        .filter((text) => text !== '')
        .join('  ')
    : '';

  return (
    <label className="inspector__field" data-testid={`world-field-${field.id}`}>
      <span className="inspector__field-label">
        {field.label}
        <ScopeBadge scope={field.scope === 'instance' ? 'INSTANCE' : 'SHARED'} />
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
        <span className="inspector__vector">
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

      {observed && <span className="inspector__observed">{observed}</span>}
      {field.description && <span className="inspector__hint">{field.description}</span>}
    </label>
  );
}
