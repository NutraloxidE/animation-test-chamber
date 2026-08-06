import type { AnimationSubjectDefinition, ProjectDefinition } from '@atc/schema';
import { LEGACY_CHARACTER_PREFAB_IDS, referencesEqual } from '@atc/schema';

/** Temporary bridge from the explicit subject into the Character-bound legacy store. */
export function legacyCharacterIdForAnimationSubject(
  subject: AnimationSubjectDefinition,
  project: ProjectDefinition,
): string | null {
  const migratedCharacterId = Object.entries(LEGACY_CHARACTER_PREFAB_IDS).find(
    ([, prefabId]) => prefabId === subject.source.prefab.assetId,
  )?.[0];
  if (migratedCharacterId && project.characters.some((character) => character.id === migratedCharacterId)) {
    return migratedCharacterId;
  }
  const assignment = subject.animator.assignment;
  const matches = project.characters.filter((character) => {
    const legacy = character.animation;
    return (
      referencesEqual(legacy.behavior, assignment.behavior) &&
      referencesEqual(legacy.motionSet, assignment.motionSet) &&
      referencesEqual(legacy.rig, assignment.rig) &&
      ((!legacy.tuning && !assignment.tuning) ||
        Boolean(legacy.tuning && assignment.tuning && referencesEqual(legacy.tuning, assignment.tuning)))
    );
  });
  return matches.length === 1 ? matches[0]!.id : null;
}
