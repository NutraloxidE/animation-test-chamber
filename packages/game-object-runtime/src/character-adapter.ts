/**
 * Borrowing the existing character runtime for a GameObject (§9.5).
 *
 * A controllable animated character is not reimplemented here. `ControllableCharacter`
 * already owns the state machine, the movement, the equipment context and the
 * root-motion policy, and a second implementation for Prefab-shaped input would
 * be a second answer to what a behaviour does — which is precisely the split
 * this work package exists to close, one layer up.
 *
 * So this file does one thing: it presents a resolved GameObject's Model,
 * Animator and Capsule components as the `CharacterDefinition` the existing
 * resolver already accepts. The adapter is deliberately dumb — it copies
 * values, it never *decides* any. Nothing here infers a model or a clip from an
 * id (§11.2, §10.2).
 */
import type { CharacterDefinition, ProjectDefinition } from '@atc/schema';
import { componentOfType } from '@atc/schema';
import type { ResolvedPrefabNode } from '@atc/prefab-runtime';
import { resolvedComponents } from '@atc/prefab-runtime';

/**
 * The capsule a character falls back to when its Prefab declares no collider.
 *
 * Stated once, here, rather than defaulted at three call sites. A GameObject
 * with an Animator and a Motor but no Capsule is authorable — nothing in the
 * schema requires all three — and it still needs a body to probe the ground
 * with.
 */
export const DEFAULT_CHARACTER_CAPSULE = { radius: 0.3, height: 1.8 } as const;

export interface CharacterViewOfGameObject {
  character: CharacterDefinition;
  /** The motion context the Animator opens in, when it names one. */
  defaultContextKey: string | undefined;
}

/**
 * A `CharacterDefinition` view of one resolved GameObject.
 *
 * `id` is the GameObject id rather than a Prefab id: `ControllableCharacter`
 * uses it as the instance identity that seeds RNG and labels observations, and
 * two instances of one Prefab must not seed identically or "independent
 * runtime state" would be false in the one place it is hardest to see.
 */
export function characterViewOfGameObject(input: {
  gameObjectId: string;
  displayName: string;
  root: ResolvedPrefabNode;
}): CharacterViewOfGameObject | undefined {
  const components = resolvedComponents(input.root);
  const animator = componentOfType(components, 'animator');
  if (!animator) return undefined;

  const model = componentOfType(components, 'model-renderer');
  const capsule = componentOfType(components, 'capsule-collider');

  return {
    character: {
      schemaVersion: 2,
      id: input.gameObjectId,
      displayName: input.displayName,
      // A GameObject with an Animator but no ModelRenderer is legal — an
      // invisible scripted driver, say — and gets a procedural stand-in rather
      // than a refusal, because the animation half resolves perfectly well
      // without geometry.
      model: model?.model ?? { kind: 'procedural-humanoid', presetId: 'navigator' },
      capsuleRadius: capsule?.radius ?? DEFAULT_CHARACTER_CAPSULE.radius,
      capsuleHeight: capsule?.height ?? DEFAULT_CHARACTER_CAPSULE.height,
      animation: animator.assignment,
    },
    defaultContextKey: animator.defaultContextKey,
  };
}

/**
 * The project a GameObject's animation resolution runs against.
 *
 * Project-level policy — movement, root motion, terrain, camera, equipment,
 * input map — stays project-level for this work package (§7.3), so the real
 * project document is passed straight through. Only `characters` is emptied,
 * because a GameObject's character view comes from its Prefab and a stale
 * `project.characters` entry with the same id would otherwise win.
 */
export function projectForGameObjectResolution(project: ProjectDefinition): ProjectDefinition {
  return { ...project, characters: [] as unknown as ProjectDefinition['characters'] };
}
