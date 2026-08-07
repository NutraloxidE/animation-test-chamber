/**
 * What the viewport draws for an exact Prefab Animator subject.
 *
 * The Rig Editor's resolver answered "who is on screen" from a
 * `CharacterDefinition`. This answers the same question from the subject, and
 * returns the same shape — `ResolvedCharacterPresentation` — so `Character`,
 * `GltfCharacter` and `ProceduralCharacter` are reused without a line changing.
 * Reusing the shape is not the same as reusing the source: nothing here reads a
 * Character, and the identity it keys by is the subject's.
 *
 * That identity matters more than it looks. The renderer keys its mixer and
 * cloned skeleton by it, so a subject switch that reused the previous key would
 * animate the new subject with the old subject's skeleton — the "stale subject
 * frame" the route's disposal exists to prevent, arriving by a different door.
 *
 * Pure and React-free, like the resolver it replaces.
 */
import type {
  CharacterModelBinding,
  ExternalAnimationSource,
  StateDefinition,
} from '@atc/schema';
import { resolveWeaponMode } from '@atc/animation-runtime';
import type { ResolvedCharacterPresentation } from '../rig-editor/resolve-character-presentation.ts';
import type { AnimationChamberDocument } from './AnimationChamberDocument.ts';

/** The motion slot a state uses in this context. */
function slotFor(state: StateDefinition, contextKey: string): string {
  return state.contextualMotionSlots?.[contextKey] ?? state.motionSlot;
}

/**
 * Builds the presentation, or `null` when the subject has no body.
 *
 * `null` rather than a substituted default: a Prefab node with no
 * ModelRenderer has no appearance, and drawing "some humanoid" there would be
 * the workspace inventing a subject the repository never authored.
 */
export function resolveAnimationSubjectPresentation(input: {
  document: AnimationChamberDocument;
  motionContextId: string;
  /** Debug-only appearance swap. `null` — the normal case — means "canonical". */
  previewModelOverridePresetId?: string | null;
}): ResolvedCharacterPresentation | null {
  const { document, motionContextId } = input;
  const canonical = document.presentation.model as CharacterModelBinding | undefined;
  if (!canonical) return null;

  const overridePresetId = input.previewModelOverridePresetId ?? null;
  /*
   * A preview override may only swap a *procedural appearance*, exactly as in
   * the Rig Editor: letting it name a model file would make it
   * indistinguishable on screen from the authored binding.
   */
  const effective: CharacterModelBinding =
    overridePresetId === null
      ? canonical
      : { kind: 'procedural-humanoid', presetId: overridePresetId };

  // One collapse of the motion context, through the same function the panels
  // use, so what plays and what the inspector shows cannot disagree.
  const forContext = resolveWeaponMode(document, motionContextId);
  const clipById = new Map(forContext.clips.map((clip) => [clip.id, clip]));

  const takeByStateId: Record<string, ExternalAnimationSource> = {};
  const loopByStateId: Record<string, boolean> = {};
  for (const state of forContext.graph.states) {
    loopByStateId[state.id] = state.loop;
    const clipId = forContext.motionBindings[slotFor(state, motionContextId)];
    const clip = clipId === undefined ? undefined : clipById.get(clipId);
    // A clip with no external source is procedural. Absence is meaningful, so
    // it stays absent rather than being filled with a placeholder take.
    if (clip?.externalSource) takeByStateId[state.id] = clip.externalSource;
  }

  return {
    // The subject id, not a Character id. It already names Prefab, version,
    // node and Component, which is exactly the granularity the renderer key
    // needs.
    characterId: document.subject.subjectId,
    displayName: document.subject.displayName,
    model: {
      canonical,
      previewOverridePresetId: overridePresetId,
      effective,
      isPreviewOverridden: overridePresetId !== null,
    },
    takeByStateId,
    sourceFiles: [
      ...new Set(Object.values(takeByStateId).map((source) => source.assetPath)),
    ].sort(),
    loopByStateId,
    instanceOverrides: document.subject.animator.assignment.instanceOverrides ?? [],
  };
}
