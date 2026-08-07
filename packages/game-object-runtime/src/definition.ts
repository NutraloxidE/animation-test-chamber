/**
 * The layer between a Prefab asset and a running object (§9.1, §9.2).
 *
 * A `ResolvedGameObjectDefinition` is one Prefab, resolved, plus one Scene
 * instance's opinion of it. It is still immutable and still contains no runtime
 * state — the point of naming it separately is that resolution order stops
 * here:
 *
 *   Prefab base → Prefab variant → nested Prefab overrides → Scene instance overrides
 *
 * Everything after this line is mutable and lives in `RuntimeGameObject`.
 */
import type {
  GameObjectInstanceBindings,
  GameObjectInstanceDefinition,
  GameObjectInstanceRelations,
  GameObjectPrefabReference,
  SceneDefinition,
  TransformDefinition,
} from '@atc/schema';
import { componentOfType, isCharacterComposition } from '@atc/schema';
import type { PrefabAssetRegistry, PrefabIssue, ResolvedPrefabNode } from '@atc/prefab-runtime';
import {
  applyComponentOverrides,
  prefabError,
  resolveGameObjectPrefab,
  resolvedComponents,
} from '@atc/prefab-runtime';

/** Where one resolved component value came from, for the Inspector's origin column. */
export interface ResolvedComponentValueSource {
  nodeId: string;
  componentId: string;
  componentType: string;
  source: 'prefab' | 'scene-instance-override';
  sourcePrefab: GameObjectPrefabReference;
}

export interface ResolvedGameObjectDefinition {
  gameObjectId: string;
  displayName: string;
  enabled: boolean;
  transform: TransformDefinition;
  prefabReference: GameObjectPrefabReference;
  root: ResolvedPrefabNode;
  bindings: GameObjectInstanceBindings;
  relations: GameObjectInstanceRelations;
  resolutionSources: ResolvedComponentValueSource[];
}

export interface ResolveGameObjectResult {
  definition: ResolvedGameObjectDefinition;
  issues: PrefabIssue[];
}

/**
 * One Scene instance, resolved.
 *
 * The instance-level checks live here rather than in the schema because they
 * are questions about the *resolved Prefab*, which a schema cannot see: whether
 * a `characterIntent` binding has a `character-motor` to drive (§6.1), whether
 * a camera relation has a Camera to aim (§6.2), and whether the Prefab is
 * abstract and therefore unplaceable (§5.9).
 */
export function resolveGameObjectInstance(input: {
  prefabRegistry: PrefabAssetRegistry;
  instance: GameObjectInstanceDefinition;
}): ResolveGameObjectResult {
  const { prefabRegistry, instance } = input;
  const resolution = resolveGameObjectPrefab(prefabRegistry, instance.prefab);
  const issues: PrefabIssue[] = [...resolution.issues];
  const root = resolution.prefab.root;

  const sources: ResolvedComponentValueSource[] = [];
  const describe = (
    source: ResolvedComponentValueSource['source'],
  ): void => {
    for (const node of flatten(root)) {
      for (const component of node.components) {
        sources.push({
          nodeId: node.nodeId,
          componentId: component.componentId,
          componentType: component.componentType,
          source,
          sourcePrefab: node.sourcePrefab,
        });
      }
    }
  };
  describe('prefab');

  if (instance.componentOverrides.length > 0) {
    issues.push(...applyComponentOverrides(root, instance.componentOverrides, instance.prefab));
    for (const override of instance.componentOverrides) {
      const entry = sources.find(
        (candidate) =>
          candidate.nodeId === override.nodeId && candidate.componentId === override.componentId,
      );
      if (entry) entry.source = 'scene-instance-override';
    }
  }

  if (resolution.prefab.abstract) {
    issues.push(
      prefabError(
        'abstract-prefab-placed',
        `GameObject "${instance.id}" places abstract Prefab "${instance.prefab.assetId}"`,
        { reference: instance.prefab },
      ),
    );
  }

  const components = resolvedComponents(root);
  if (instance.bindings.characterIntent && !componentOfType(components, 'character-motor')) {
    issues.push(
      prefabError(
        'invalid-instance-binding',
        `GameObject "${instance.id}" binds a character intent but its Prefab has no character-motor`,
        { reference: instance.prefab },
      ),
    );
  }
  if (
    instance.relations.cameraTargetGameObjectId !== undefined &&
    !componentOfType(components, 'camera')
  ) {
    issues.push(
      prefabError(
        'invalid-instance-relation',
        `GameObject "${instance.id}" names a camera target but its Prefab has no camera`,
        { reference: instance.prefab },
      ),
    );
  }

  return {
    definition: {
      gameObjectId: instance.id,
      displayName: instance.displayName,
      enabled: instance.enabled,
      transform: instance.transform,
      prefabReference: instance.prefab,
      root,
      bindings: instance.bindings,
      relations: instance.relations,
      resolutionSources: sources,
    },
    issues,
  };
}

export interface ResolveSceneGameObjectsResult {
  definitions: ResolvedGameObjectDefinition[];
  issues: PrefabIssue[];
}

/**
 * Every GameObject in a Scene, in declaration order (§9.7).
 *
 * A broken instance produces issues and *no* definition, never a substituted
 * one — the same rule the Scene resolver already follows, and for the same
 * reason: silently falling back to something runnable makes a typo look like a
 * working Scene.
 */
export function resolveSceneGameObjects(input: {
  prefabRegistry: PrefabAssetRegistry;
  scene: SceneDefinition;
}): ResolveSceneGameObjectsResult {
  const definitions: ResolvedGameObjectDefinition[] = [];
  const issues: PrefabIssue[] = [];
  for (const instance of input.scene.gameObjects ?? []) {
    const result = resolveGameObjectInstance({
      prefabRegistry: input.prefabRegistry,
      instance,
    });
    issues.push(...result.issues);
    if (result.issues.some((issue) => issue.severity === 'error')) continue;
    definitions.push(result.definition);
  }
  const cameraTargets = new Set(definitions.map((definition) => definition.gameObjectId));
  for (const definition of definitions) {
    const target = definition.relations.cameraTargetGameObjectId;
    if (target !== undefined && !cameraTargets.has(target)) {
      issues.push(
        prefabError(
          'invalid-instance-relation',
          `GameObject "${definition.gameObjectId}" follows unknown GameObject "${target}"`,
          { reference: definition.prefabReference },
        ),
      );
    }
  }
  return { definitions, issues };
}

function flatten(node: ResolvedPrefabNode): ResolvedPrefabNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

/** Whether a resolved object is a controllable animated character (§9.5). */
export function isCharacterGameObject(definition: ResolvedGameObjectDefinition): boolean {
  return isCharacterComposition(resolvedComponents(definition.root));
}
