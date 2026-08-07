/**
 * Turning a canonical Scene into runnable characters.
 *
 * One responsibility, and it is the definition/instance split: two entities
 * naming the same Character must share the resolved animation bundle they were
 * built from, and must not share a single mutable byte of what happens next.
 *
 * There is no synthesis path here. The old world resolver invented a
 * one-instance world for a project that had none, because something had to
 * tick; a Scene is always explicit, and a project with no Scene simply has no
 * Scene to run.
 */
import type {
  AssetIssue,
  CanonicalPatch,
  CharacterSceneEntity,
  ProjectDefinition,
  ResolvedProject,
  SceneDefinition,
} from '@atc/schema';
import type {
  AnimationAssetRegistry,
  ResolvedAnimationBundle,
} from '@atc/animation-asset-runtime';
import {
  materializeResolvedProject,
  resolveCharacterAnimationBundle,
} from '@atc/animation-asset-runtime';
import { animationResolutionKey } from './animation-key.ts';

export interface ResolvedSceneCharacter {
  definition: CharacterSceneEntity;
  /**
   * This entity's resolved document. **Never shared** between entities, even
   * when they resolve to the same assets: it carries the character's own id,
   * display name, model path and capsule dimensions, and two different
   * characters on one animation set must not receive each other's body.
   */
  resolved: ResolvedProject;
  /**
   * The character-independent half, which *is* shared by reference with every
   * entity whose animation inputs hash to the same key.
   */
  bundle: ResolvedAnimationBundle;
  /** Key the *bundle* was cached under. Carries no character identity. */
  animationResolutionKey: string;
  issues: AssetIssue[];
}

export interface ResolveSceneRequest {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  scene: SceneDefinition;
  /** Unsaved editor edits, applied to every entity that shares the asset. */
  previewOverrides?: readonly CanonicalPatch[];
}

export interface ResolveSceneResult {
  scene: SceneDefinition;
  characters: ResolvedSceneCharacter[];
  issues: AssetIssue[];
}

/**
 * Resolves every character entity in the scene.
 *
 * Entities are returned in declaration order, which is also tick order
 * (DECISION 0009). Nothing downstream re-sorts them; a stable order that
 * something later shuffles is not an order.
 *
 * A broken character reference produces a validation issue and *no* character,
 * never a substituted one. Silently falling back to the first character in the
 * project would make a typo in a reference look like a working scene.
 */
export function resolveScene(request: ResolveSceneRequest): ResolveSceneResult {
  // Bundles, never resolved projects. The value type here is the fix for the
  // character-contamination bug, and the scene harness asserts it structurally.
  const cache = new Map<string, { bundle: ResolvedAnimationBundle; issues: AssetIssue[] }>();
  const characters: ResolvedSceneCharacter[] = [];
  const issues: AssetIssue[] = [];

  for (const entity of request.scene.entities) {
    if (entity.kind !== 'character') continue;

    const character = request.project.characters.find((entry) => entry.id === entity.characterId);
    if (!character) {
      issues.push({
        severity: 'error',
        code: 'missing-reference',
        message: `entity "${entity.id}" references unknown character "${entity.characterId}"`,
        path: `/scenes/${request.scene.id}/entities/${entity.id}/characterId`,
      });
      continue;
    }

    const key = animationResolutionKey(character, request.previewOverrides ?? []);
    let entry = cache.get(key);
    if (!entry) {
      entry = resolveCharacterAnimationBundle({
        registry: request.registry,
        project: request.project,
        characterId: character.id,
        ...(request.previewOverrides ? { previewOverrides: request.previewOverrides } : {}),
      });
      cache.set(key, entry);
    }

    issues.push(...entry.issues);
    characters.push({
      definition: entity,
      // A fresh wrapper per entity, around a shared bundle.
      resolved: materializeResolvedProject({
        project: request.project,
        character,
        bundle: entry.bundle,
      }),
      bundle: entry.bundle,
      animationResolutionKey: key,
      issues: entry.issues,
    });
  }

  return { scene: request.scene, characters, issues };
}

/** The scene a route or a default navigation preference names. Never a guess. */
export function sceneOf(
  project: ProjectDefinition,
  sceneId: string,
): SceneDefinition | undefined {
  return project.scenes.find((scene) => scene.id === sceneId);
}

export { animationResolutionKey, canonicalPatchKey } from './animation-key.ts';
