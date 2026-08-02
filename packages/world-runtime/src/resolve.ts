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
  AssetReference,
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
  referenceKey,
} from '@atc/schema';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import { resolveCharacterAnimation } from '@atc/animation-asset-runtime';

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

/** The project's explicit world, or the synthesized one. Never null. */
export function worldOf(project: ProjectDefinition): WorldDefinition {
  return project.world ?? synthesizeLegacyWorld(project);
}

/** True when the world came from `synthesizeLegacyWorld`. */
export function isSynthesizedWorld(project: ProjectDefinition): boolean {
  return project.world === undefined;
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
   * The resolved document this instance runs. Shared by reference with every
   * other instance resolving to the same assets — see `resolutionKey`.
   */
  resolved: ResolvedProject;
  /** Key the resolved document was cached under; instance-independent. */
  resolutionKey: string;
  issues: AssetIssue[];
}

/**
 * Cache key for a resolved document.
 *
 * Built from the *asset references*, never from the character id. Keying on the
 * character would be right until the day two characters resolved differently
 * from the same id — a preview override is enough — and the cache would then
 * hand one instance the other's graph with nothing to notice it.
 */
export function resolutionKey(character: CharacterDefinition): string {
  const references: (AssetReference | undefined)[] = [
    character.animation.behavior,
    character.animation.motionSet,
    character.animation.rig,
    character.animation.tuning,
  ];
  const overrides = character.animation.instanceOverrides
    .map((patch) => `${patch.path}=${JSON.stringify(patch.value)}`)
    .join('|');
  return `${references.map((r) => (r ? referenceKey(r) : '-')).join('+')}#${overrides}`;
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
  const cache = new Map<string, { resolved: ResolvedProject; issues: AssetIssue[] }>();
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

    const key = resolutionKey(character);
    let entry = cache.get(key);
    if (!entry) {
      const result = resolveCharacterAnimation({
        registry: request.registry,
        project: request.project,
        characterId: character.id,
        ...(request.previewOverrides ? { previewOverrides: request.previewOverrides } : {}),
      });
      entry = { resolved: result.project, issues: result.issues };
      cache.set(key, entry);
    }

    issues.push(...entry.issues);
    instances.push({
      definition,
      resolved: entry.resolved,
      resolutionKey: key,
      issues: entry.issues,
    });
  }

  return { world, instances, issues };
}
