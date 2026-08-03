/**
 * Controls that belong to the character being authored, not to a camera.
 *
 * The weapon-grip editor used to sit in the World viewport's `Controls`
 * overlay. That was already a slightly odd home — a grip is Character/Rig
 * attachment configuration, not a display option — and it became an outright
 * broken one when the skinned renderer moved: the gizmo it drives only exists
 * in Character Lab's preview stage, so the control stayed in World pointing at
 * nothing.
 *
 * It lives with the thing it edits now.
 */
import { useChamber } from '../store.ts';
import { characterPreset, weaponMode } from '../three/catalog.ts';

export function CharacterLabStageControls() {
  const characterPresetId = useChamber((state) => state.characterPresetId);
  const weaponModeId = useChamber((state) => state.weaponModeId);
  const gripEditorMode = useChamber((state) => state.gripEditorMode);
  const setGripEditorMode = useChamber((state) => state.setGripEditorMode);
  const resetWeaponGrip = useChamber((state) => state.resetWeaponGrip);

  // A grip is only editable where both the rig and the held item exist; the
  // procedural fallback has neither.
  const gripSupported = Boolean(
    characterPreset(characterPresetId).weaponGrips?.[weaponModeId] &&
      weaponMode(weaponModeId).heldItem,
  );

  return (
    <details className="character-lab__stage-controls" data-testid="character-lab-stage-controls" open>
      <summary>Stage</summary>
      <div className="character-lab__stage-controls-body">
        <label className="viewport-select">
          Grip
          <select
            value={gripEditorMode ?? 'off'}
            disabled={!gripSupported}
            onChange={(event) =>
              setGripEditorMode(
                event.target.value === 'off'
                  ? null
                  : (event.target.value as 'translate' | 'rotate'),
              )
            }
            data-testid="grip-editor-select"
          >
            <option value="off">Off</option>
            <option value="translate">Move · autosave</option>
            <option value="rotate">Rotate · autosave</option>
          </select>
        </label>
        {gripEditorMode && (
          <button
            type="button"
            onClick={() => resetWeaponGrip(characterPresetId, weaponModeId)}
            data-testid="reset-grip"
          >
            Reset grip
          </button>
        )}
      </div>
    </details>
  );
}
