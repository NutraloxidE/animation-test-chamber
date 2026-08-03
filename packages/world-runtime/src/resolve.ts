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
import type {
  AnimationAssetRegistry,
  ResolvedAnimationBundle,
} from '@atc/animation-asset-runtime';
import {
  materializeResolvedProject,
  resolveCharacterAnimationBundle,
} from '@atc/animation-asset-runtime';

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

/**
 * Cache key for a resolved *animation bundle*.
 *
 * Every input that can change the bundle participates: the four asset
 * references, the character's animation `instanceOverrides`, and the preview
 * overrides in force for this resolution. Nothing that only changes the
 * character wrapper does — id, display name, model path and capsule dimensions
 * are deliberately absent, because two characters that differ only in those
 * ways genuinely can share a bundle.
 *
 * Keying on the character id was the original mistake and would be wrong in
 * both directions: it under-shares between two characters with one animation
 * set, and over-shares the moment one id resolves two ways.
 */
export function animationResolutionKey(
  character: CharacterDefinition,
  previewOverrides: readonly CanonicalPatch[] = [],
): string {
  const references: (AssetReference | undefined)[] = [
    character.animation.behavior,
    character.animation.motionSet,
    character.animation.rig,
    character.animation.tuning,
  ];
  return [
    references.map((r) => (r ? referenceKey(r) : '-')).join('+'),
    canonicalPatchKey(character.animation.instanceOverrides),
    canonicalPatchKey(previewOverrides),
  ].join('#');
}

/**
 * Deterministic serialization of a patch list.
 *
 * `JSON.stringify` of a patch value follows the key insertion order of whatever
 * JSON was parsed, so two semantically identical patches read from differently
 * ordered files would hash differently and silently miss the cache. Sorting
 * object keys at every depth removes that.
 */
export function canonicalPatchKey(patches: readonly CanonicalPatch[]): string {
  return patches.map((patch) => `${patch.op}:${patch.path}=${stableJson(patch.value)}`).join('|');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
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
