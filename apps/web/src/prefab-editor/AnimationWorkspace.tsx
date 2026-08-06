/**
 * The animation authoring workspace, opened from an Animator Component (§4).
 *
 * The workspace itself is not rebuilt here. `<App />` is the screen the tuning
 * workflow was built on, and a second graph editor for the same assets would be
 * a second answer to what a behaviour does — the exact split this cutover
 * exists to close.
 *
 * What this file is, honestly, is an **adapter with a shelf life**. The
 * workspace still keys off the store's animation subject, which is still a
 * canonical `CharacterDefinition`; §9 replaces that with
 * `AnimationSubjectDefinition`, at which point the mapping below disappears and
 * the Animator's own assignment names the subject directly. Until then the
 * mapping is derived from the one migration table rather than guessed, so it
 * cannot drift from what the Prefabs actually are.
 */
import { useEffect } from 'react';
import { LEGACY_CHARACTER_PREFAB_IDS } from '@atc/schema';
import { App } from '../App.tsx';
import { useChamber } from '../store.ts';

/**
 * The animation subject a Prefab's Animator edits.
 *
 * Inverted from the migration table, so "which Character became this Prefab"
 * has one answer. A Prefab with no legacy ancestor returns `null` and the
 * workspace says so rather than opening somebody else's graph.
 */
export function animationSubjectId(prefabId: string): string | null {
  const entry = Object.entries(LEGACY_CHARACTER_PREFAB_IDS).find(
    ([, mapped]) => mapped === prefabId,
  );
  return entry?.[0] ?? null;
}

export function AnimationWorkspace({ subjectId }: { subjectId: string | null }): JSX.Element {
  const activeCharacterId = useChamber((state) => state.activeCharacterId);
  const setActiveCharacter = useChamber((state) => state.setActiveCharacter);
  const known = useChamber((state) =>
    state.canonicalProject.characters.some((character) => character.id === subjectId),
  );

  useEffect(() => {
    if (subjectId === null || !known) return;
    if (activeCharacterId === subjectId) return;
    setActiveCharacter(subjectId);
  }, [subjectId, known, activeCharacterId, setActiveCharacter]);

  if (subjectId === null || !known) {
    return (
      <p data-testid="prefab-animation-workspace-unavailable">
        This Prefab has no animation subject in the project yet, so the authoring workspace has
        nothing to open. Its Animator assignment is shown in the Inspector.
      </p>
    );
  }

  // One frame of the previous subject's graph is exactly the confusion route
  // identity exists to remove, so the workspace waits rather than showing it.
  if (activeCharacterId !== subjectId) {
    return <p data-testid="prefab-animation-workspace-loading">Loading {subjectId}…</p>;
  }
  return <App />;
}
