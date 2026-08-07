/**
 * Hierarchy (Unity's left-hand scene tree).
 *
 * Not a new model: every row is something the store already owns — the active
 * character, its weapon, the equipment slots, the terrain, and the animator
 * states. Clicking a row selects it and brings up the panel that edits it, so
 * the tree is the navigation and the right-hand dock is the inspector.
 */
import { useChamber, useCharacterBindings, useCharacterPresentation, useWeaponProject } from '../store.ts';
import { PROCEDURAL_APPEARANCES, WEAPON_MODES, proceduralAppearance, weaponMode } from '../three/catalog.ts';

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
  const presentation = useCharacterPresentation();
  const previewModelOverrideId = useChamber((state) => state.previewModelOverrideId);
  const setPreviewModelOverride = useChamber((state) => state.setPreviewModelOverride);
  const weaponModeId = useChamber((state) => state.weaponModeId);
  const setWeaponMode = useChamber((state) => state.setWeaponMode);
  const equipped = useChamber((state) => state.equipped);
  const setEquipped = useChamber((state) => state.setEquipped);
  const terrainPresetId = useChamber((state) => state.terrainPresetId);
  const selectedStateId = useChamber((state) => state.selectedStateId);
  const selectState = useChamber((state) => state.selectState);

  const bindings = useCharacterBindings();
  const binding = bindings.find((entry) => entry.characterId === presentation.characterId);

  const canonical = presentation.model.canonical;
  const canonicalModelLabel =
    canonical.kind === 'procedural-humanoid'
      ? `procedural-humanoid:${canonical.presetId}`
      : `repository-model:${canonical.assetPath}`;

  return (
    <div className="hierarchy" data-testid="hierarchy">
      <header className="hierarchy__header">Hierarchy</header>
      <div className="hierarchy__tree">
        <Row depth={0} kind="◇" label={project.displayName} />

        {/*
          The Character row names the canonical Character and nothing else. It
          used to read `<Character name> (<preview preset label>)` above an inline
          preset selector, so the row mixed two identities — one authored, one
          transient — with no way to tell which half was which, and the selector
          silently changed only the second. Switching Character is navigation now
          (the Rig Editor header), so no control here can disagree with the URL.
        */}
        <Row
          depth={1}
          kind="☗"
          label={project.character.displayName}
          onClick={() => setPanel('inspector')}
          testId="hierarchy-character-row"
        />
        <div className="hierarchy__binding" data-testid="hierarchy-model-binding">
          <span className="hierarchy__binding-label">Model</span>
          <code>{canonicalModelLabel}</code>
          {presentation.model.isPreviewOverridden && (
            <span className="badge badge--preview" data-testid="hierarchy-preview-badge">
              PREVIEW ONLY
            </span>
          )}
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

        {/*
          "Animator" alone named nothing (§3.5) — it was a label for a graph
          whose identity, version and holders were all invisible from here. The
          row names the Behavior asset it actually opens.
        */}
        <Row
          depth={1}
          kind="◈"
          label={
            binding
              ? `Behavior / Animator · ${binding.behavior.reference.assetId}@${binding.behavior.reference.version}`
              : 'Behavior / Animator'
          }
          onClick={() => setPanel('graph')}
          testId="hierarchy-behavior-row"
        />
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

      {/*
        The preview override, and everything about how it is presented is the
        point. It sits in its own collapsed debug section rather than beside the
        Character row; it is labelled "Preview Model Override", never "Character";
        it says out loud that it is not saved; and it defaults to None. It exists
        because comparing appearances against one Character's tuning is genuinely
        useful — but it is a debug tool, and the previous version of this control
        was mistaken for the Character selector, which is how five appearances
        came to look like five Characters.
      */}
      <details className="hierarchy__preview" data-testid="preview-model-override">
        <summary>
          Preview Model Override
          <span className="badge badge--preview">PREVIEW ONLY</span>
        </summary>
        <div className="hierarchy__preview-body">
          <select
            value={previewModelOverrideId ?? 'none'}
            onChange={(event) =>
              setPreviewModelOverride(event.target.value === 'none' ? null : event.target.value)
            }
            data-testid="preview-model-override-select"
            aria-label="Preview Model Override"
          >
            <option value="none">None — show the canonical model</option>
            {PROCEDURAL_APPEARANCES.map((appearance) => (
              <option key={appearance.id} value={appearance.id}>
                {appearance.label}
              </option>
            ))}
          </select>
          <p className="hierarchy__preview-note">
            Not saved to the Character. Resets when you open another Character, and
            is never staged or applied.
            {previewModelOverrideId !== null && (
              <>
                {' '}
                Canonical model: <code>{canonicalModelLabel}</code>; previewing{' '}
                <code>procedural-humanoid:{proceduralAppearance(previewModelOverrideId).id}</code>.
              </>
            )}
          </p>
        </div>
      </details>
    </div>
  );
}
