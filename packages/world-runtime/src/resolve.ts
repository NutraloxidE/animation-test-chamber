/**
 * Turning a canonical project into a runnable world.
 *
 * Two responsibilities, both about the definition/instance split:
 *   - a project with no `world` still has to run, so one is synthesized;
 *   - two instances naming the same character must share the resolved document
 *     they were built from, and must not share a single mutable byte of what
 *     happens next.
 */
import type {
  AssetIssue,
  CanonicalPatch,
  CharacterDefinition,
  ProjectDefinition,
  ResolvedProject,
  RuntimeInstanceDefinition,
  WorldDefinition,
} from '@atc/schema';
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_INSTANCE_TRANSFORM,
  activeCharacter,
} from '@atc/schema';
import type {
  AnimationAssetRegistry,
  ResolvedAnimationBundle,
} from '@atc/animation-asset-runtime';
import {
  materializeResolvedProject,
  resolveCharacterAnimationBundle,
} from '@atc/animation-asset-runtime';
import { defaultScene, sceneAsWorld } from './scene-compat.ts';
// Moved to @atc/scene-runtime; re-exported so this package's public surface is
// unchanged for the tests that have not migrated yet.
import { animationResolutionKey, canonicalPatchKey } from '@atc/scene-runtime';

export { animationResolutionKey, canonicalPatchKey };

/**
 * The world a legacy project runs as.
 *
 * One instance, built from `activeCharacterId`. This is what keeps the focused
 * chamber honest: it is not a second runtime kept alive next to the world one,
 * it is the world runtime with a single instance in it. A bug that only the
 * world path had would therefore be a bug the focused path had too, which is
 * the only version of "compatible" worth having.
 */
export function synthesizeLegacyWorld(project: ProjectDefinition): WorldDefinition {
  const character = activeCharacter(project);
  const instanceId = legacyInstanceId(character);
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'synthesized-focused-world',
    displayName: `${project.displayName} (focused)`,
    instances: [
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        id: instanceId,
        displayName: character.displayName,
        source: { kind: 'character', characterId: character.id },
        transform: { ...DEFAULT_INSTANCE_TRANSFORM, position: { ...DEFAULT_INSTANCE_TRANSFORM.position } },
        intentSource: { kind: 'local-input', playerIndex: 0 },
        enabled: true,
      },
    ],
    intentTracks: [],
    focusedInstanceId: instanceId,
    cameraTargetInstanceId: instanceId,
  };
}

/**
 * The instance id a synthesized world uses.
 *
 * Derived from the character id rather than a constant so a legacy trace names
 * something a human recognises, and stable so a legacy replay recorded today
 * still matches tomorrow.
 */
export function legacyInstanceId(character: CharacterDefinition): string {
  return character.id;
}

/**
 * The world this project runs as. Never null.
 *
 * Three sources, in descending order of how directly the project said it:
 * a legacy `world` still on the document, the project's default Scene viewed
 * through the transitional adapter, and finally the one-instance world
 * synthesized from `activeCharacterId`.
 *
 * The Scene step is what keeps this package's tests meaningful after the demo
 * project migrated: without it a project that ships two composed characters
 * would open here as one synthesized instance, and every world test would keep
 * passing while asserting nothing about the data a human actually opens.
 */
export function worldOf(project: ProjectDefinition): WorldDefinition {
  if (project.world) return project.world;
  const scene = defaultScene(project);
  return (scene && sceneAsWorld(scene)) ?? synthesizeLegacyWorld(project);
}

/** True when the world came from `synthesizeLegacyWorld` — no world *and* no usable scene. */
export function isSynthesizedWorld(project: ProjectDefinition): boolean {
  if (project.world) return false;
  const scene = defaultScene(project);
  return !scene || sceneAsWorld(scene) === undefined;
}

/**
 * Adds an explicit world to a legacy project.
 *
 * Explicit, and never called on load. Rewriting every project the moment it is
 * opened would turn "I looked at it" into a diff, and the first casualty would
 * be the guarantee that a read-only repository stays byte-identical.
 */
export function migrateProjectToExplicitWorld(project: ProjectDefinition): ProjectDefinition {
  if (project.world) return project;
  return { ...project, world: synthesizeLegacyWorld(project) };
}

export interface ResolvedInstance {
  definition: RuntimeInstanceDefinition;
  /**
   * This instance's resolved document. **Never shared** between instances, even
   * when they resolve to the same assets: it carries the character's own id,
   * display name, model path and capsule dimensions, and two different
   * characters on one animation set must not receive each other's body.
   */
  resolved: ResolvedProject;
  /**
   * The character-independent half, which *is* shared by reference with every
   * instance whose animation inputs hash to the same key.
   */
  bundle: ResolvedAnimationBundle;
  /** Key the *bundle* was cached under. Carries no character identity. */
  animationResolutionKey: string;
  issues: AssetIssue[];
}

export interface ResolveWorldRequest {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  /** Unsaved chamber edits, applied to every instance that shares the asset. */
  previewOverrides?: readonly CanonicalPatch[];
  /** Defaults to `worldOf(project)`; pass a staged world to preview it. */
  world?: WorldDefinition;
}

export interface ResolveWorldResult {
  world: WorldDefinition;
  instances: ResolvedInstance[];
  issues: AssetIssue[];
}

/**
 * Resolves every instance in the world.
 *
 * Instances are returned in declaration order, which is also tick order
 * (DECISION 0009). Nothing downstream re-sorts them; a stable order that
 * something later shuffles is not an order.
 */
export function resolveWorld(request: ResolveWorldRequest): ResolveWorldResult {
  const world = request.world ?? worldOf(request.project);
  // Bundles, never resolved projects. The value type here is the fix for the
  // character-contamination bug, and `harness:world` asserts it structurally.
  const cache = new Map<string, { bundle: ResolvedAnimationBundle; issues: AssetIssue[] }>();
  const instances: ResolvedInstance[] = [];
  const issues: AssetIssue[] = [];

  for (const definition of world.instances) {
    const character = request.project.characters.find(
      (entry) => entry.id === definition.source.characterId,
    );
    if (!character) {
      issues.push({
        severity: 'error',
        code: 'missing-reference',
        message: `instance "${definition.id}" references unknown character "${definition.source.characterId}"`,
        path: `/world/instances/${definition.id}/source/characterId`,
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
    instances.push({
      definition,
      // A fresh wrapper per instance, around a shared bundle.
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

  return { world, instances, issues };
}
