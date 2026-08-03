/**
 * Project / Assets: the reusable definitions and the Character browser.
 *
 * `Character render preset` used to live at the top of this panel, under a
 * SHARED badge, described as "which model and rig the chamber draws this
 * character with". Every part of that framing was wrong: it is not canonical,
 * it changes no Character Definition, it affects one renderer, and sitting
 * under a SHARED badge next to genuinely shared asset controls made it read as
 * the project's character selector (DECISION 0014).
 *
 * Canonical Characters are the list now. What to render is resolved *from* the
 * Character Definition — see `character-lab/canonical-character-render.ts` —
 * and the catalogue survives only as an adapter behind it. The dev-only picker
 * moved to Diagnostics, where a renderer setting belongs.
 */
import { useChamber } from '../store.ts';
import { AssetLibrary } from '../asset-library/AssetLibrary.tsx';
import { CHARACTER_PRESETS } from '../three/catalog.ts';
import { CharacterBrowser } from '../project/CharacterBrowser.tsx';

/**
 * The render-preset picker, kept for development and named for what it is.
 *
 * Retained rather than deleted because the migration to canonical model
 * resolution is incomplete, and removing the only way to exercise the skinned
 * renderer would remove the ability to notice it broke. Hidden behind a
 * `<details>` labelled Diagnostics so it is not a primary control, and called
 * `Preview Renderer` so nobody reads it as Character identity again.
 */
function PreviewRendererDiagnostics() {
  const characterPresetId = useChamber((state) => state.characterPresetId);
  const setCharacterPreset = useChamber((state) => state.setCharacterPreset);

  return (
    <details className="project-diagnostics" data-testid="project-diagnostics">
      <summary>Diagnostics</summary>
      <div className="workspace__row">
        <label>
          Preview Renderer · Fallback Model
          <select
            value={characterPresetId}
            data-testid="preview-renderer-select"
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
          Development only. This is a renderer catalogue entry, not a Character Definition — it
          changes nothing canonical and no Runtime Instance references it.
        </p>
      </div>
    </details>
  );
}

export function ProjectWorkspace() {
  return (
    <div className="workspace workspace--project" data-testid="project-workspace">
      <CharacterBrowser />
      <AssetLibrary />
      <PreviewRendererDiagnostics />
    </div>
  );
}
