/**
 * One equipment slot, on one instance.
 *
 * The selection this renders is a *projection*: the world document has no
 * attachment entity, and adding one purely so the tree could be a level deeper
 * would have cost a schema migration, generated output, a Unity DTO review and
 * a legacy compatibility story to buy an indentation level. The slot is
 * project data; which instance it belongs to comes from the selection; the
 * effective state comes from definition-plus-override.
 *
 * If explicit attachment entities ever arrive, the selection semantics here do
 * not have to change — which is the point of deriving rather than inventing.
 */
import { useChamber } from '../store.ts';
import { useLoadout } from './useLoadout.ts';
import { ScopeBadge } from './sections/ScopeBadge.tsx';

export function AttachmentInspector({
  instanceId,
  slotId,
}: {
  instanceId: string;
  slotId: string;
}) {
  const loadout = useLoadout(instanceId);
  const instance = useChamber((state) =>
    state.stagedWorld.instances.find((entry) => entry.id === instanceId),
  );
  const setInstanceEquipment = useChamber((state) => state.setInstanceEquipment);
  const openCharacter = useChamber((state) => state.openCharacterDefinition);
  const selectScene = useChamber((state) => state.selectScene);

  const slot = loadout?.equipment.find((entry) => entry.slotId === slotId);
  if (!slot || !instance) {
    return (
      <p className="inspector__empty" data-testid="inspector-missing-attachment">
        That attachment is no longer in the scene.
      </p>
    );
  }

  return (
    <div className="inspector inspector--attachment" data-testid="attachment-inspector">
      <header className="inspector__header">
        <h2>{slot.label}</h2>
        <ScopeBadge scope="INSTANCE" />
      </header>

      <section className="inspector__section" data-testid="inspector-attachment-identity">
        <h3>Attachment</h3>
        <dl className="inspector__provenance">
          <dt>Slot id</dt>
          <dd data-testid="attachment-slot-id">{slot.slotId}</dd>
          <dt>On instance</dt>
          <dd>
            <button
              type="button"
              data-testid="attachment-parent-instance"
              onClick={() => selectScene({ kind: 'instance', instanceId })}
            >
              {instance.displayName}
            </button>
          </dd>
          <dt>Effective</dt>
          <dd data-testid="attachment-effective">
            {slot.effective ? 'equipped' : 'not equipped'}
          </dd>
        </dl>
      </section>

      <section className="inspector__section" data-testid="inspector-attachment-override">
        <h3>
          Instance Override
          <ScopeBadge scope={slot.override === null ? 'INHERITED' : 'OVERRIDDEN'} />
        </h3>
        <label className="inspector__field">
          <span className="inspector__field-label">Equipped for this instance</span>
          <input
            type="checkbox"
            checked={slot.effective}
            data-testid="attachment-equipped-input"
            title="Override this equipment slot for this instance."
            onChange={(event) => setInstanceEquipment(instanceId, slotId, event.target.checked)}
          />
        </label>
        <p className="inspector__hint" data-testid="attachment-scope-explanation">
          Definition default: {slot.definition ? 'equipped' : 'not equipped'} · this instance:{' '}
          {slot.override === null ? 'follows the definition' : slot.override ? 'equipped' : 'not equipped'}
        </p>
        <button
          type="button"
          data-testid="attachment-reset"
          disabled={slot.override === null}
          onClick={() => setInstanceEquipment(instanceId, slotId, null)}
        >
          Reset to definition default
        </button>
      </section>

      <section className="inspector__section" data-testid="inspector-attachment-shared">
        <h3>
          Shared Definition
          <ScopeBadge scope="SHARED" />
        </h3>
        <p className="inspector__hint">
          The slot itself, and its default, belong to the character definition. Changing the default
          affects every instance referencing it.
        </p>
        <button
          type="button"
          className="inspector__action"
          data-testid="attachment-open-definition"
          onClick={() => openCharacter(instance.source.characterId)}
        >
          Open Character Definition
        </button>
      </section>
    </div>
  );
}
