/**
 * The Scene hierarchy, as data (§6).
 *
 * Rows are derived from `scene.gameObjects` and the Prefab registry, never from
 * `scene.entities`. What each root row has to say is different in kind from what
 * an entity row said: an entity row answered "what kind of thing is this", and a
 * GameObject row answers "which exact Prefab version is this a placement of, and
 * what does that Prefab contain".
 *
 * Pure and React-free on purpose. "This Scene yields exactly these rows, with
 * these badges" is the property worth testing, and it needs no DOM.
 *
 * Every id in here is a *stable* id — the Scene instance id, the Prefab node id,
 * the Component id (§6.1). No array index appears anywhere: an index means
 * something different after a reorder, and reordering is a first-class Scene
 * operation.
 */
import type { GameObjectInstanceDefinition, SceneDefinition } from '@atc/schema';
import {
  resolveGameObjectPrefab,
  walkResolvedNodes,
  type PrefabAssetRegistry,
} from '@atc/prefab-runtime';

export interface SceneHierarchyComponentRow {
  componentId: string;
  componentType: string;
  /** True when this instance overrides this Component's values (§7.1). */
  overridden: boolean;
}

export interface SceneHierarchyNodeRow {
  /** Prefab node id, stable within the resolved graph. */
  nodeId: string;
  /** The runtime id the renderer draws this node under: `<instanceId>/<nodeId>`. */
  runtimeId: string;
  displayName: string;
  depth: number;
  /** True when the node came from a nested Prefab rather than the outer one. */
  nested: boolean;
  /** Which Prefab version actually contributed this node. */
  sourcePrefabId: string;
  sourcePrefabVersion: string;
  components: SceneHierarchyComponentRow[];
}

export interface SceneHierarchyRow {
  /** The Scene instance id. The only thing a persistent operation may name. */
  instanceId: string;
  displayName: string;
  enabled: boolean;
  prefabId: string;
  /** The exact version, never "latest" (§6). */
  prefabVersion: string;
  derivation: 'base' | 'variant' | 'fork';
  /** Component types on the whole resolved composition, for the badge row. */
  componentTypes: string[];
  /** How many instance-scoped Component overrides this placement carries. */
  overrideCount: number;
  /** The controller binding, when there is one, as a short badge string. */
  bindingBadge: string | undefined;
  /** The camera relation, when there is one. */
  relationBadge: string | undefined;
  /** True when the Scene plays through this object. */
  activeCamera: boolean;
  /** Resolution failed. The row still exists so the failure is visible (§4.4). */
  unresolved: boolean;
  unresolvedReason: string | undefined;
  /** The resolved Prefab's nodes, for the expanded view. Empty when unresolved. */
  nodes: SceneHierarchyNodeRow[];
}

function bindingBadgeOf(instance: GameObjectInstanceDefinition): string | undefined {
  const intent = instance.bindings.characterIntent;
  if (!intent) return undefined;
  switch (intent.kind) {
    case 'human':
      return `player ${intent.playerIndex}`;
    case 'script':
      return `script ${intent.trackId}`;
    case 'ai':
      return `ai ${intent.channelId}`;
    case 'replay':
      return `replay ${intent.replayId}`;
    case 'none':
      return 'unbound';
  }
}

export function sceneHierarchyRows(input: {
  scene: SceneDefinition;
  registry: PrefabAssetRegistry;
}): SceneHierarchyRow[] {
  const { scene, registry } = input;

  return (scene.gameObjects ?? []).map((instance) => {
    const resolution = resolveGameObjectPrefab(registry, instance.prefab);
    /*
     * `base` / `variant` / `fork` comes from the *stored* document, not the
     * resolved one: resolution's whole job is to collapse a variant's patches
     * into a finished composition, so by the time it is done there is nothing
     * left that says it was ever a variant. The badge is about provenance.
     */
    const stored = registry.find(instance.prefab);
    const error = resolution.issues.find((issue) => issue.severity === 'error');
    const nodes = error ? [] : walkResolvedNodes(resolution.prefab.root);
    const overridden = new Set(
      instance.componentOverrides.map((override) => `${override.nodeId}/${override.componentId}`),
    );

    /*
     * Depth comes from the node path rather than from a recursive walk index,
     * because `walkResolvedNodes` flattens the tree and the row list is flat
     * too. The path is `root/child/grandchild`, so its segment count is the
     * depth — one derivation, from the id the resolver already assigned.
     */
    const depthOf = (nodePath: string): number => nodePath.split('/').length - 1;

    return {
      instanceId: instance.id,
      displayName: instance.displayName,
      enabled: instance.enabled,
      prefabId: instance.prefab.assetId,
      prefabVersion: instance.prefab.version,
      derivation: stored?.derivation.mode ?? 'base',
      componentTypes: [
        ...new Set(nodes.flatMap((node) => node.components.map((c) => c.componentType))),
      ].sort(),
      overrideCount: instance.componentOverrides.length,
      bindingBadge: bindingBadgeOf(instance),
      relationBadge:
        instance.relations.cameraTargetGameObjectId === undefined
          ? undefined
          : `follows ${instance.relations.cameraTargetGameObjectId}`,
      activeCamera: scene.activeCameraGameObjectId === instance.id,
      unresolved: error !== undefined,
      unresolvedReason: error ? `${error.code}: ${error.message}` : undefined,
      nodes: nodes.map((node) => ({
        nodeId: node.nodeId,
        runtimeId:
          node.nodePath === resolution.prefab.root.nodePath
            ? instance.id
            : `${instance.id}/${node.nodeId}`,
        displayName: node.displayName,
        depth: depthOf(node.nodePath),
        nested: node.nested,
        sourcePrefabId: node.sourcePrefab.assetId,
        sourcePrefabVersion: node.sourcePrefab.version,
        components: node.components.map((component) => ({
          componentId: component.componentId,
          componentType: component.componentType,
          overridden: overridden.has(`${node.nodeId}/${component.componentId}`),
        })),
      })),
    };
  });
}

/** The row for one instance, or `undefined`. Never an index lookup. */
export function hierarchyRowFor(
  rows: readonly SceneHierarchyRow[],
  instanceId: string,
): SceneHierarchyRow | undefined {
  return rows.find((row) => row.instanceId === instanceId);
}
