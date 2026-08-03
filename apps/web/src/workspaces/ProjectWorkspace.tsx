/**
 * Project / Assets: the reusable definitions, and the chamber's render preset.
 *
 * The character preset picker used to sit in the pseudo-hierarchy, next to the
 * shield toggle, which put "which visual definition does the chamber render?"
 * and "does this one instance carry a shield?" one row apart despite one being
 * shared and the other being scoped to a single instance. It belongs here,
 * under a SHARED badge, because changing it changes what every view of that
 * character looks like.
 */
import { useChamber } from '../store.ts';
import { AssetLibrary } from '../asset-library/AssetLibrary.tsx';
import { CHARACTER_PRESETS } from '../three/catalog.ts';
import { ScopeBadge } from '../inspector/sections/ScopeBadge.tsx';

export function ProjectWorkspace() {
  const characterPresetId = useChamber((state) => state.characterPresetId);
  const setCharacterPreset = useChamber((state) => state.setCharacterPreset);

  return (
    <div className="workspace workspace--project" data-testid="project-workspace">
      <div className="workspace__row">
        <label>
          Character render preset
          <ScopeBadge scope="SHARED" />
          <select
            value={characterPresetId}
            data-testid="character-select"
            onChange={(event) => setCharacterPreset(event.target.value)}
          >
            {CHARACTER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <p className="workspace__hint">
          Which model and rig the chamber draws this character with. Shared: every instance
          referencing it is affected.
        </p>
      </div>
      <AssetLibrary />
    </div>
  );
}
