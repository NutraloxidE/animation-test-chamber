/**
 * What to render for a canonical Character Definition.
 *
 * The old path was backwards: a browser catalogue (`CHARACTER_PRESETS`) held
 * model URLs, scales, rotations, clip maps, rig ids and weapon grips, and the
 * user picked an entry from it under the label `Character render preset`. That
 * control is not canonical, does not change what any Instance references, and
 * sits next to controls that *are* canonical — so it reads as the project's
 * character selector while being a renderer setting.
 *
 * Resolution now starts from the Character Definition and consults the
 * catalogue only as an **adapter**: the definition says which model asset and
 * which rig, and the catalogue supplies the renderer-specific adaptation for
 * that model until those fields have a canonical home. A Character with
 * `modelAssetPath: null` resolves to the procedural body, explicitly and by
 * design — the chamber has always had to boot with no assets.
 *
 * The direction of the arrow is the whole point. Canonical identity decides
 * what is rendered; the catalogue only says how.
 */
import type { CharacterDefinition } from '@atc/schema';
import { CHARACTER_PRESETS, type CharacterPreset } from '../three/catalog.ts';

export type CharacterRenderKind = 'procedural-fallback' | 'model';

export interface CanonicalCharacterRender {
  characterId: string;
  displayName: string;
  kind: CharacterRenderKind;
  /** Canonical model asset path, or null for the procedural fallback. */
  modelAssetPath: string | null;
  /**
   * The catalogue entry supplying renderer adaptation for this model, when one
   * exists. Never a user selection, and never canonical identity.
   */
  adapter: CharacterPreset | null;
  /** True when a model is declared but nothing knows how to render it yet. */
  adapterMissing: boolean;
  rigAssetId: string;
  behaviorAssetId: string;
  motionSetAssetId: string;
}

/**
 * The adapter for a canonical model path.
 *
 * Matched on `modelUrl` rather than on id: the catalogue's ids are demo preset
 * names, and matching those to Character ids would re-create exactly the
 * identity confusion this module exists to remove.
 */
export function adapterForModel(modelAssetPath: string | null): CharacterPreset | null {
  if (!modelAssetPath) return null;
  return (
    CHARACTER_PRESETS.find((preset) => preset.modelUrl === modelAssetPath) ?? null
  );
}

/** The procedural body, used when a Character declares no model. */
export function proceduralFallback(): CharacterPreset {
  // The first catalogue entry is the procedural body and has no `modelUrl`;
  // falling back to "whatever is first" would be a coincidence, so this asserts
  // the property it actually depends on.
  const fallback = CHARACTER_PRESETS.find((preset) => !preset.modelUrl);
  if (!fallback) {
    throw new Error('the render catalogue has no procedural entry to fall back to');
  }
  return fallback;
}

export function resolveCharacterRender(
  character: CharacterDefinition,
): CanonicalCharacterRender {
  const modelAssetPath = character.modelAssetPath ?? null;
  const adapter = adapterForModel(modelAssetPath);
  return {
    characterId: character.id,
    displayName: character.displayName,
    kind: modelAssetPath ? 'model' : 'procedural-fallback',
    modelAssetPath,
    adapter,
    // Declared but unrenderable is a real state and has to be visible: the
    // alternative is a character that silently renders as somebody else's body.
    adapterMissing: modelAssetPath !== null && adapter === null,
    rigAssetId: character.animation.rig.assetId,
    behaviorAssetId: character.animation.behavior.assetId,
    motionSetAssetId: character.animation.motionSet.assetId,
  };
}

/** Human-readable one-liner for the Character Lab header and validation panel. */
export function describeCharacterRender(render: CanonicalCharacterRender): string {
  if (render.kind === 'procedural-fallback') {
    return 'Procedural fallback — this Character declares no model asset.';
  }
  if (render.adapterMissing) {
    return `Model “${render.modelAssetPath}” has no render adapter; showing the procedural fallback.`;
  }
  return `Model ${render.modelAssetPath}`;
}
