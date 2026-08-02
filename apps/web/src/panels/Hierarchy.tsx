/**
 * Hierarchy (Unity's left-hand scene tree).
 *
 * Not a new model: every row is something the store already owns — the active
 * character, its weapon, the equipment slots, the terrain, and the animator
 * states. Clicking a row selects it and brings up the panel that edits it, so
 * the tree is the navigation and the right-hand dock is the inspector.
 */
import { useChamber, useWeaponProject } from '../store.ts';
import { CHARACTER_PRESETS, WEAPON_MODES, characterPreset, weaponMode } from '../three/catalog.ts';

function Row({
  depth,
  label,
  kind,
  active,
  onClick,
  enabled,
  onToggle,
  testId,
}: {
  depth: number;
  label: string;
  kind: string;
  active?: boolean;
  onClick?: () => void;
  enabled?: boolean;
  onToggle?: (next: boolean) => void;
  testId?: string;
}) {
  return (
    <div className={`hierarchy__row${active ? ' is-active' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}>
      {onToggle ? (
        <input
          type="checkbox"
          checked={enabled ?? true}
          onChange={(event) => onToggle(event.target.checked)}
          title="Active"
          {...(testId ? { 'data-testid': testId } : {})}
        />
      ) : (
        <span className="hierarchy__spacer" />
      )}
      <button type="button" className="hierarchy__label" onClick={onClick} disabled={!onClick}>
        <span className="hierarchy__icon">{kind}</span>
        {label}
      </button>
    </div>
  );
}

export function Hierarchy() {
  const project = useWeaponProject();
  const setPanel = useChamber((state) => state.setPanel);
  const characterPresetId = useChamber((state) => state.characterPresetId);
  const setCharacterPreset = useChamber((state) => state.setCharacterPreset);
  const weaponModeId = useChamber((state) => state.weaponModeId);
  const setWeaponMode = useChamber((state) => state.setWeaponMode);
  const equipped = useChamber((state) => state.equipped);
  const setEquipped = useChamber((state) => state.setEquipped);
  const terrainPresetId = useChamber((state) => state.terrainPresetId);
  const selectedStateId = useChamber((state) => state.selectedStateId);
  const selectState = useChamber((state) => state.selectState);

  return (
    <div className="hierarchy" data-testid="hierarchy">
      <header className="hierarchy__header">Hierarchy</header>
      <div className="hierarchy__tree">
        <Row depth={0} kind="◇" label={project.displayName} />

        <Row
          depth={1}
          kind="☗"
          label={`${project.character.displayName} (${characterPreset(characterPresetId).label})`}
          onClick={() => setPanel('inspector')}
        />
        <div className="hierarchy__inline" style={{ paddingLeft: 34 }}>
          <select
            value={characterPresetId}
            onChange={(event) => setCharacterPreset(event.target.value)}
            data-testid="character-select"
          >
            {CHARACTER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label}</option>
            ))}
          </select>
        </div>

        <Row depth={2} kind="⚔" label={weaponMode(weaponModeId).label} onClick={() => setPanel('timing')} />
        <div className="hierarchy__inline" style={{ paddingLeft: 48 }}>
          <select
            value={weaponModeId}
            onChange={(event) => setWeaponMode(event.target.value)}
            data-testid="weapon-mode-select"
          >
            {WEAPON_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>{mode.label}</option>
            ))}
          </select>
        </div>

        {project.equipment.map((slot) => (
          <Row
            key={slot.id}
            depth={2}
            kind="▣"
            label={slot.label}
            enabled={equipped[slot.id] ?? slot.defaultEquipped}
            onToggle={(next) => setEquipped(slot.id, next)}
            testId={`equip-${slot.id}`}
          />
        ))}

        <Row depth={1} kind="▦" label={`Terrain · ${terrainPresetId}`} onClick={() => setPanel('terrain')} />

        <Row depth={1} kind="◈" label="Animator" onClick={() => setPanel('graph')} />
        {project.graph.layers.map((layer) => (
          <div key={layer.id}>
            <Row depth={2} kind="≣" label={layer.id} onClick={() => setPanel('graph')} />
            {project.graph.states
              .filter((state) => state.layer === layer.id)
              .map((state) => (
                <Row
                  key={state.id}
                  depth={3}
                  kind="●"
                  label={state.id}
                  active={selectedStateId === state.id}
                  onClick={() => {
                    selectState(state.id);
                    setPanel('graph');
                  }}
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
