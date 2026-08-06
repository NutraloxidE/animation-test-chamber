/**
 * The repository tuning the chamber document needs, and nothing else.
 *
 * `movement`, `rootMotion`, `terrain`, `camera`, `inputMap`, `haptics`,
 * `equipment` and the preference block are project-level in the canonical
 * schema — they were never Character-level — so an exact Prefab Animator
 * subject can be tuned against them without a Character existing anywhere in
 * the path.
 *
 * This hook is the narrow window onto the store. It lives outside
 * `animation-chamber/` on purpose: the native directory must not import the
 * Character-bound store at all, and a hook that returns eight named profiles
 * cannot leak `characters` or `activeCharacterId` to a caller that only ever
 * receives its return value.
 */
import { useMemo } from 'react';
import { useChamber } from '../store.ts';
import type { AnimationChamberRepositoryDefaults } from '../animation-chamber/AnimationChamberDocument.ts';

export function useAnimationRepositoryDefaults(): AnimationChamberRepositoryDefaults {
  const project = useChamber((state) => state.canonicalProject);
  return useMemo(
    () => ({
      movement: project.movement,
      rootMotion: project.rootMotion,
      terrain: project.terrain,
      camera: project.camera,
      inputMap: project.inputMap,
      haptics: project.haptics,
      equipment: project.equipment,
      preferences: project.preferences,
      defaultTerrainPresetId: project.defaultTerrainPresetId,
      revisionId: project.revisionId,
    }),
    [project],
  );
}
