/**
 * The one resolver that decides what the Rig Editor shows (work package §9.4).
 *
 * Before this file there were two answers to "who is on screen". The route
 * resolved a `CharacterDefinition` and rebuilt the canonical animation
 * document; the Viewport, independently, read a `characterPresetId` out of the
 * store and drew whatever the web-only catalog listed under it. Navigating from
 * one Character to another changed the header and the graph while leaving the
 * model alone — which is exactly the reported symptom, "selecting different
 * entries appears to open the same rig".
 *
 * Worse, playback had the same split: the canonical Behavior decided which
 * *state* was active, and a `stateId -> GLTF clip name` map beside the renderer
 * decided which *animation* you saw. Two graphs, no mechanism to keep them
 * honest.
 *
 * So both decisions live here, together, derived from canonical data only:
 *
 *   route Character -> resolved document -> model binding    (what to draw)
 *                                       -> motion bindings  (what to play)
 *
 * `GltfCharacter` and `ProceduralCharacter` are handed the result. Neither is
 * allowed to choose a model or a clip of its own — that independence is what let
 * the two graphs drift while every test stayed green.
 *
 * Pure and React-free: the property worth testing is "this document plus this
 * weapon mode yields exactly these takes", which needs no renderer.
 */
import type {
  CanonicalPatch,
  CharacterModelBinding,
  ExternalAnimationSource,
  ResolvedProject,
  StateDefinition,
} from '@atc/schema';
import { resolveWeaponMode } from '@atc/animation-runtime';

export interface CharacterModelPresentation {
  /** What the repository says this Character looks like. Always authored. */
  canonical: CharacterModelBinding;
  /** A transient debug override. Never canonical, never saved (§3.6). */
  previewOverridePresetId: string | null;
  /** What the Viewport actually draws — canonical unless a preview overrides it. */
  effective: CharacterModelBinding;
  isPreviewOverridden: boolean;
}

export interface ResolvedCharacterPresentation {
  characterId: string;
  displayName: string;
  model: CharacterModelPresentation;
  /**
   * Graph state id -> the imported take that state plays, for this weapon mode.
   *
   * Empty for a procedural Character, which is the honest answer: it has no
   * imported takes, and an entry here would imply a file that does not exist.
   */
  takeByStateId: Record<string, ExternalAnimationSource>;
  /** Distinct files the takes above live in, sorted. What the loader must fetch. */
  sourceFiles: string[];
  /** Canonical loop flag per state, so the renderer never re-derives it. */
  loopByStateId: Record<string, boolean>;
  instanceOverrides: readonly CanonicalPatch[];
}

/** The motion slot a state uses in this weapon context. */
function slotFor(state: StateDefinition, weaponModeId: string): string {
  return state.contextualMotionSlots?.[weaponModeId] ?? state.motionSlot;
}

export function resolveRigEditorCharacterPresentation(input: {
  /** The document resolved for the route Character. Contexts not yet collapsed. */
  project: ResolvedProject;
  weaponModeId: string;
  /** Debug-only appearance swap. `null` — the normal case — means "canonical". */
  previewModelOverridePresetId?: string | null;
}): ResolvedCharacterPresentation {
  const { project, weaponModeId } = input;
  const overridePresetId = input.previewModelOverridePresetId ?? null;
  const canonical = project.character.model;

  /*
   * A preview override may only ever swap a *procedural appearance*. Letting it
   * name a model file would make it indistinguishable from the authored binding
   * on screen, which is the confusion the whole package exists to remove.
   */
  const effective: CharacterModelBinding =
    overridePresetId === null
      ? canonical
      : { kind: 'procedural-humanoid', presetId: overridePresetId };

  // One collapse of the weapon context, in one place: the same function the
  // panels use, so what plays and what the inspector shows cannot disagree.
  const forWeapon = resolveWeaponMode(project, weaponModeId);
  const clipById = new Map(forWeapon.clips.map((clip) => [clip.id, clip]));

  const takeByStateId: Record<string, ExternalAnimationSource> = {};
  const loopByStateId: Record<string, boolean> = {};
  for (const state of forWeapon.graph.states) {
    loopByStateId[state.id] = state.loop;
    const clipId = forWeapon.motionBindings[slotFor(state, weaponModeId)];
    const clip = clipId === undefined ? undefined : clipById.get(clipId);
    // A clip with no external source is procedural. Absence is meaningful here,
    // so it is left absent rather than filled with a placeholder take.
    if (clip?.externalSource) takeByStateId[state.id] = clip.externalSource;
  }

  return {
    characterId: project.character.id,
    displayName: project.character.displayName,
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
    instanceOverrides: project.character.animation.instanceOverrides,
  };
}

/**
 * The grip for a held item: the Character's authored default, or a session
 * override from the in-viewport grip editor.
 *
 * Authored defaults now live on the model binding rather than on a preview
 * preset, so a grip somebody positioned by hand is reviewable repository data.
 * The override stays transient on purpose — it is what the grip editor writes
 * while being dragged.
 */
export function resolveWeaponGrip(input: {
  model: CharacterModelBinding;
  weaponModeId: string;
  sessionOverride?: { position: [number, number, number]; rotation: [number, number, number] };
}): { position: [number, number, number]; rotation: [number, number, number] } | undefined {
  if (input.sessionOverride) return input.sessionOverride;
  if (input.model.kind !== 'repository-model') return undefined;
  return input.model.weaponGrips?.[input.weaponModeId];
}
