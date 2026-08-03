/**
 * Weapon mode and equipment, for one explicit instance.
 *
 * This is where the shield toggle and the weapon-mode picker live now. Both
 * used to be global focused-engine setters — `setWeaponMode(id)`, with no
 * instance anywhere in the signature — so in a world holding two instances of
 * the same character there was no answer the code could give to "which one did
 * that change?". Every control here names an instance and dispatches an
 * instance-qualified command, which is the same path the API and the AI take.
 *
 * The three-layer readout (definition / override / effective) is not decoration
 * either: "Shield off" and "Shield off because the shared character says off"
 * are different facts, and only one of them is safe to fix by toggling.
 */
import { useChamber } from '../../store.ts';
import { useLoadout } from '../useLoadout.ts';
import { WEAPON_MODES } from '../../three/catalog.ts';
import { ScopeBadge } from './ScopeBadge.tsx';

export function LoadoutSection({ instanceId }: { instanceId: string }) {
  const loadout = useLoadout(instanceId);
  const setInstanceWeaponMode = useChamber((state) => state.setInstanceWeaponMode);
  const setInstanceEquipment = useChamber((state) => state.setInstanceEquipment);
  const resetInstanceLoadout = useChamber((state) => state.resetInstanceLoadout);

  if (!loadout) return null;
  const { weaponMode, equipment } = loadout;

  return (
    <section className="inspector__section" data-testid="inspector-loadout">
      <h3>Loadout</h3>

      <label className="inspector__field" data-testid="loadout-weapon-mode">
        <span className="inspector__field-label">
          Weapon Mode
          <ScopeBadge scope="INSTANCE" />
          <ScopeBadge scope={weaponMode.override === null ? 'INHERITED' : 'OVERRIDDEN'} />
        </span>
        <select
          value={weaponMode.effective}
          data-testid="loadout-weapon-mode-input"
          onChange={(event) => setInstanceWeaponMode(instanceId, event.target.value)}
        >
          {WEAPON_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
        <span className="inspector__hint" data-testid="loadout-weapon-mode-scope">
          Definition default: {weaponMode.definition} · effective: {weaponMode.effective}
        </span>
        <button
          type="button"
          data-testid="loadout-weapon-mode-reset"
          disabled={weaponMode.override === null}
          onClick={() => setInstanceWeaponMode(instanceId, null)}
        >
          Reset to character default
        </button>
      </label>

      {equipment.map((slot) => (
        <label
          className="inspector__field"
          key={slot.slotId}
          data-testid={`loadout-equipment-${slot.slotId}`}
        >
          <span className="inspector__field-label">
            {slot.label}
            <ScopeBadge scope="INSTANCE" />
            <ScopeBadge scope={slot.override === null ? 'INHERITED' : 'OVERRIDDEN'} />
          </span>
          <input
            type="checkbox"
            checked={slot.effective}
            data-testid={`loadout-equipment-${slot.slotId}-input`}
            title="Override this equipment slot for this instance."
            onChange={(event) =>
              setInstanceEquipment(instanceId, slot.slotId, event.target.checked)
            }
          />
          <span className="inspector__hint" data-testid={`loadout-equipment-${slot.slotId}-scope`}>
            Definition default: {slot.definition ? 'equipped' : 'not equipped'} · effective:{' '}
            {slot.effective ? 'equipped' : 'not equipped'}
          </span>
          <button
            type="button"
            data-testid={`loadout-equipment-${slot.slotId}-reset`}
            disabled={slot.override === null}
            onClick={() => setInstanceEquipment(instanceId, slot.slotId, null)}
          >
            Reset to definition default
          </button>
        </label>
      ))}

      <button
        type="button"
        className="inspector__action"
        data-testid="loadout-reset-all"
        disabled={!loadout.hasOverrides}
        onClick={() => resetInstanceLoadout(instanceId)}
      >
        Reset entire loadout overrides
      </button>
    </section>
  );
}
