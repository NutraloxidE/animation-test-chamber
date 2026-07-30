import type { AnimationGraphDefinition, ProjectDefinition } from '@atc/schema';

/**
 * Resolves the document for one weapon mode.
 *
 * Each state picks its weapon's clip, each transition takes that weapon's timing
 * overrides, and the clips belonging to the other weapons are dropped. Past this
 * point nothing — runtime, panels, diffing — has to know weapons exist: it sees
 * one ordinary project whose attacks happen to be this weapon's.
 *
 * The graph itself is deliberately not per weapon. Combo structure and cancel
 * routes are the character's, not the sword's.
 */
export function resolveWeaponMode(
  project: ProjectDefinition,
  weaponModeId: string,
): ProjectDefinition {
  const graph = resolveGraph(project.graph, weaponModeId);
  const used = new Set(graph.states.map((state) => state.clipId));
  return {
    ...project,
    graph,
    clips: project.clips.filter((clip) => used.has(clip.id)),
  };
}

function resolveGraph(
  graph: AnimationGraphDefinition,
  weaponModeId: string,
): AnimationGraphDefinition {
  return {
    ...graph,
    states: graph.states.map(({ weaponClips, ...state }) => ({
      ...state,
      clipId: weaponClips?.[weaponModeId] ?? state.clipId,
    })),
    transitions: graph.transitions.map(({ weaponOverrides, ...transition }) =>
      weaponOverrides?.[weaponModeId]
        ? { ...transition, ...weaponOverrides[weaponModeId] }
        : transition,
    ),
  };
}
