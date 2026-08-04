/**
 * Route-to-Character resolution. One resolver, and no fallback.
 *
 * The rule that matters is negative: `/edit/rig/character-a` must never end up
 * editing `character-b`, and an unknown id must produce a not-found state
 * rather than quietly opening the first character in the project (work package
 * §4.2). "Fall back to something so the page renders" is the single most
 * plausible-looking way to violate that — the page looks fine, the panels look
 * fine, and the human is tuning the wrong character.
 *
 * Pure, and deliberately free of React: the property under test is "this id
 * resolves to exactly this character, or to nothing", which needs no DOM.
 */
import type { CharacterDefinition, ProjectDefinition } from '@atc/schema';

export type RigEditorTarget =
  | { status: 'resolved'; characterId: string; character: CharacterDefinition }
  | { status: 'missing'; characterId: string; available: CharacterDefinition[] }
  | { status: 'no-target'; available: CharacterDefinition[] };

/**
 * Resolves the Character named by the route.
 *
 * `characterId` is `null` when the route carried no usable parameter at all,
 * which is a different state from "an id that names nothing": the first wants a
 * chooser, the second wants an error naming the id that failed.
 */
export function resolveRigEditorTarget(
  project: ProjectDefinition,
  characterId: string | null,
): RigEditorTarget {
  const available = [...project.characters];
  if (characterId === null) return { status: 'no-target', available };

  // Exact match only. No prefix matching, no case folding, no "closest" id —
  // each of those turns a typo into a successful edit of the wrong document.
  const character = project.characters.find((entry) => entry.id === characterId);
  if (!character) return { status: 'missing', characterId, available };

  return { status: 'resolved', characterId, character };
}

/**
 * Where `/` should send someone.
 *
 * `activeCharacterId` is a *navigation preference* and is used only here. Once
 * the browser is on `/edit/rig/:characterId`, the route wins and this field is
 * never consulted again — which is what stops it becoming a second, hidden
 * answer to "which character is being edited".
 */
export function defaultRigEditorCharacterId(project: ProjectDefinition): string | null {
  const active = project.characters.find((entry) => entry.id === project.activeCharacterId);
  return (active ?? project.characters[0])?.id ?? null;
}
