import type {
  AnimationClipDefinition,
  AnimationGraphDefinition,
} from '@atc/schema';

/**
 * The document as one weapon mode sees it.
 *
 * The mechanism underneath changed: a weapon is now a contextual key on a
 * motion set binding, so *every* character gets per-weapon clips through the
 * same path instead of through a map living on the state. What this function
 * still does is collapse that choice for one mode — its bindings, its
 * transition timing, and none of the other weapons' clips — so that past this
 * point nothing has to know weapons exist.
 *
 * The graph itself is deliberately still not per weapon. Combo structure and
 * cancel routes are the character's, not the sword's.
 */
export function resolveWeaponMode<
  TDocument extends {
    graph: AnimationGraphDefinition;
    clips: AnimationClipDefinition[];
    motionBindings: Record<string, string>;
    contextualMotionBindings: Record<string, Record<string, string>>;
  },
>(project: TDocument, weaponModeId: string): TDocument {
  const graph = resolveGraph(project.graph, weaponModeId);
  const motionBindings: Record<string, string> = {
    ...project.motionBindings,
    ...(project.contextualMotionBindings[weaponModeId] ?? {}),
  };
  const used = new Set(
    graph.states
      .map((state) => motionBindings[state.contextualMotionSlots?.[weaponModeId] ?? state.motionSlot])
      .filter((clipId): clipId is string => clipId !== undefined),
  );
  return {
    ...project,
    graph,
    motionBindings,
    clips: project.clips.filter((clip) => used.has(clip.id)),
  };
}

function resolveGraph(
  graph: AnimationGraphDefinition,
  weaponModeId: string,
): AnimationGraphDefinition {
  return {
    ...graph,
    transitions: graph.transitions.map(({ weaponOverrides, ...transition }) =>
      weaponOverrides?.[weaponModeId]
        ? { ...transition, ...weaponOverrides[weaponModeId] }
        : transition,
    ),
  };
}
