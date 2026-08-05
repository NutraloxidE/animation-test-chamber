/**
 * Prefab resolution (§8.2).
 *
 * Resolution order, and it is the whole contract:
 *
 *   base/fork payload
 *     → variant parent chain
 *       → variant Prefab patches
 *         → nested Prefab resolution
 *
 * The result is a deep-owned immutable value. No caller mutates a registry
 * document, because no caller is ever handed one: a resolved Prefab is built
 * from clones, and the runtime layer above it holds the only mutable state in
 * the system.
 *
 * A fork deliberately never reads its parent. That is what "detached" means —
 * deleting the Prefab a fork came from must be harmless, or a fork is just a
 * variant with worse provenance.
 */
import type {
  GameObjectComponentDefinition,
  GameObjectPrefabAsset,
  GameObjectPrefabReference,
  PrefabComponentOverride,
  PrefabNodeDefinition,
  PrefabPatch,
  RepositoryAssetReference,
  TransformDefinition,
} from '@atc/schema';
import { prefabHasStoredRoot, prefabReferenceKey } from '@atc/schema';
import { type PrefabIssue, prefabError } from './issues.ts';
import { applyComponentPatches } from './patch.ts';
import type { PrefabAssetRegistry } from './registry.ts';
import { composeTransforms } from './transform-math.ts';

/**
 * A node after resolution.
 *
 * `nodePath` exists and `nodeId` is kept because they answer different
 * questions. `nodeId` is what an override names — stable, authored, and unique
 * only within the Prefab that declared it. `nodePath` is where the node ended
 * up in *this* resolved tree, which is the only thing unique once nested
 * Prefabs have been expanded.
 */
export interface ResolvedPrefabNode {
  nodeId: string;
  nodePath: string;
  displayName: string;
  enabled: boolean;
  transform: TransformDefinition;
  components: GameObjectComponentDefinition[];
  children: ResolvedPrefabNode[];
  /** The Prefab version that actually contributed this node. */
  sourcePrefab: GameObjectPrefabReference;
  /** True when the node came from a nested Prefab rather than the outer one. */
  nested: boolean;
}

export interface ResolvedGameObjectPrefab {
  reference: GameObjectPrefabReference;
  id: string;
  displayName: string;
  abstract: boolean;
  root: ResolvedPrefabNode;
  /** Every asset this Prefab needs, transitively, deduplicated and ordered. */
  dependencies: RepositoryAssetReference[];
}

export interface PrefabResolution {
  prefab: ResolvedGameObjectPrefab;
  issues: PrefabIssue[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A node with every component and child owned outright, ready to be patched. */
function toResolvedNode(
  node: PrefabNodeDefinition,
  sourcePrefab: GameObjectPrefabReference,
  nodePath: string,
  nested: boolean,
): ResolvedPrefabNode {
  return {
    nodeId: node.nodeId,
    nodePath,
    displayName: node.displayName,
    enabled: node.enabled,
    transform: clone(node.transform),
    components: clone(node.components),
    children: node.children
      .filter((child) => child.kind === 'inline')
      .map((child) =>
        toResolvedNode(
          (child as { kind: 'inline'; node: PrefabNodeDefinition }).node,
          sourcePrefab,
          `${nodePath}/${(child as { kind: 'inline'; node: PrefabNodeDefinition }).node.nodeId}`,
          nested,
        ),
      ),
    sourcePrefab,
    nested,
  };
}

function findNode(root: ResolvedPrefabNode, nodeId: string): ResolvedPrefabNode | undefined {
  if (root.nodeId === nodeId && !root.nested) return root;
  for (const child of root.children) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Applies a variant's patches to its resolved parent.
 *
 * Every patch names a node by stable id, and a patch that names a node the
 * parent no longer has is an error rather than a no-op: a variant whose
 * overrides quietly stopped applying is a variant that has silently reverted to
 * its parent, which is the failure mode this whole addressing scheme exists to
 * prevent.
 */
function applyPrefabPatches(
  root: ResolvedPrefabNode,
  patches: readonly PrefabPatch[],
  reference: GameObjectPrefabReference,
): PrefabIssue[] {
  const issues: PrefabIssue[] = [];
  for (const patch of patches) {
    const node = findNode(root, patch.nodeId);
    if (!node) {
      issues.push(
        prefabError(
          'invalid-override-target',
          `no node "${patch.nodeId}" to patch in ${prefabReferenceKey(reference)}'s parent`,
          { path: `/nodes/${patch.nodeId}`, reference },
        ),
      );
      continue;
    }
    switch (patch.kind) {
      case 'patch-component': {
        const index = node.components.findIndex(
          (component) => component.componentId === patch.componentId,
        );
        if (index === -1) {
          issues.push(
            prefabError(
              'invalid-override-target',
              `node "${patch.nodeId}" has no component "${patch.componentId}" to patch`,
              { path: `/nodes/${patch.nodeId}/components/${patch.componentId}`, reference },
            ),
          );
          break;
        }
        const applied = applyComponentPatches(node.components[index]!, patch.patches, {
          nodeId: patch.nodeId,
          componentId: patch.componentId,
        });
        node.components[index] = applied.component;
        issues.push(...applied.issues.map((issue) => ({ ...issue, reference })));
        break;
      }
      case 'add-component': {
        if (
          node.components.some(
            (component) => component.componentId === patch.component.componentId,
          )
        ) {
          issues.push(
            prefabError(
              'duplicate-component-id',
              `node "${patch.nodeId}" already has a component "${patch.component.componentId}"`,
              { path: `/nodes/${patch.nodeId}/components/${patch.component.componentId}`, reference },
            ),
          );
          break;
        }
        node.components.push(clone(patch.component));
        break;
      }
      case 'remove-component': {
        const index = node.components.findIndex(
          (component) => component.componentId === patch.componentId,
        );
        if (index === -1) {
          issues.push(
            prefabError(
              'invalid-override-target',
              `node "${patch.nodeId}" has no component "${patch.componentId}" to remove`,
              { path: `/nodes/${patch.nodeId}/components/${patch.componentId}`, reference },
            ),
          );
          break;
        }
        node.components.splice(index, 1);
        break;
      }
      case 'set-node-transform':
        node.transform = clone(patch.transform);
        break;
      case 'set-node-enabled':
        node.enabled = patch.enabled;
        break;
    }
  }
  return issues;
}

/**
 * Applies a set of component overrides — a nested Prefab instance's, or a Scene
 * instance's. Unlike a variant patch these cannot add or remove components:
 * an instance that could add a component would be authoring a Prefab in a place
 * nothing versions.
 */
export function applyComponentOverrides(
  root: ResolvedPrefabNode,
  overrides: readonly PrefabComponentOverride[],
  reference: GameObjectPrefabReference,
): PrefabIssue[] {
  const issues: PrefabIssue[] = [];
  for (const override of overrides) {
    const node = findNode(root, override.nodeId);
    if (!node) {
      issues.push(
        prefabError(
          'invalid-override-target',
          `no node "${override.nodeId}" in ${prefabReferenceKey(reference)}`,
          { path: `/nodes/${override.nodeId}`, reference },
        ),
      );
      continue;
    }
    const index = node.components.findIndex(
      (component) => component.componentId === override.componentId,
    );
    if (index === -1) {
      issues.push(
        prefabError(
          'invalid-override-target',
          `node "${override.nodeId}" has no component "${override.componentId}"`,
          { path: `/nodes/${override.nodeId}/components/${override.componentId}`, reference },
        ),
      );
      continue;
    }
    const applied = applyComponentPatches(node.components[index]!, override.patches, {
      nodeId: override.nodeId,
      componentId: override.componentId,
    });
    node.components[index] = applied.component;
    issues.push(...applied.issues.map((issue) => ({ ...issue, reference })));
  }
  return issues;
}

function dependencyKey(reference: RepositoryAssetReference): string {
  return `${reference.assetType}:${reference.assetId}@${reference.version}`;
}

function collectDependencies(node: ResolvedPrefabNode, into: Map<string, RepositoryAssetReference>): void {
  for (const component of node.components) {
    if (component.componentType !== 'animator') continue;
    const { behavior, motionSet, rig, tuning } = component.assignment;
    for (const reference of [behavior, motionSet, rig, ...(tuning ? [tuning] : [])]) {
      into.set(dependencyKey(reference), reference);
    }
  }
  for (const child of node.children) collectDependencies(child, into);
}

interface ResolveContext {
  registry: PrefabAssetRegistry;
  /**
   * Lineage ids currently being *nested*, for cycle refusal.
   *
   * Kept separate from the variant chain below it: nesting walks down and
   * inheritance walks up, and one shared stack would report a Prefab that
   * legitimately nests a sibling of its own parent as a cycle.
   */
  nestingStack: string[];
  issues: PrefabIssue[];
  dependencies: Map<string, RepositoryAssetReference>;
}

/**
 * The payload of one Prefab, before nested instances are expanded.
 *
 * Split out because the variant chain and the nesting expansion are different
 * recursions with different cycle rules: a variant chain walks *up*, nesting
 * walks *down*, and conflating them would let a Prefab nest its own parent
 * without either check noticing.
 */
function resolvePayload(
  reference: GameObjectPrefabReference,
  context: ResolveContext,
  variantStack: string[],
): ResolvedPrefabNode | undefined {
  const asset: GameObjectPrefabAsset | undefined = context.registry.find(reference);
  if (!asset) {
    context.issues.push(
      prefabError('missing-prefab', `no Prefab ${prefabReferenceKey(reference)}`, { reference }),
    );
    return undefined;
  }
  context.issues.push(...context.registry.checkReference(reference));

  if (prefabHasStoredRoot(asset)) {
    return toResolvedNode(asset.root, reference, asset.root.nodeId, false);
  }

  const parent = asset.derivation.parent;
  if (variantStack.includes(parent.assetId)) {
    context.issues.push(
      prefabError(
        'variant-parent-cycle',
        `variant chain cycles at "${parent.assetId}" (${[...variantStack, parent.assetId].join(' -> ')})`,
        { reference },
      ),
    );
    return undefined;
  }
  variantStack.push(parent.assetId);
  const parentRoot = resolvePayload(parent, context, variantStack);
  variantStack.pop();
  if (!parentRoot) return undefined;

  context.issues.push(...applyPrefabPatches(parentRoot, asset.derivation.patches, reference));
  // The resolved node's source is the variant, not the parent: "which Prefab
  // version produced this?" must answer with the one that was referenced, or
  // the Inspector's inheritance badges point at the wrong document.
  return retagSource(parentRoot, reference);
}

function retagSource(
  node: ResolvedPrefabNode,
  reference: GameObjectPrefabReference,
): ResolvedPrefabNode {
  if (!node.nested) node.sourcePrefab = reference;
  for (const child of node.children) retagSource(child, reference);
  return node;
}

/**
 * Expands nested Prefab instances in place.
 *
 * A nested instance contributes a subtree whose nodes are marked `nested`, so a
 * later override addressed at the *outer* Prefab's `nodeId` cannot accidentally
 * match a node the nested Prefab happens to have called `root` too. That is why
 * `findNode` skips nested nodes: an override belongs to the Prefab that
 * declared it, and reaching into a nested Prefab happens through that
 * instance's own `overrides` list.
 */
function expandNested(
  stored: PrefabNodeDefinition,
  resolved: ResolvedPrefabNode,
  context: ResolveContext,
): void {
  const inlineChildren = stored.children.filter((child) => child.kind === 'inline');
  for (const [index, child] of inlineChildren.entries()) {
    const target = resolved.children[index];
    if (target) expandNested(child.node, target, context);
  }

  for (const child of stored.children) {
    if (child.kind !== 'prefab-instance') continue;
    if (context.nestingStack.includes(child.prefab.assetId)) {
      context.issues.push(
        prefabError(
          'nested-prefab-cycle',
          `Prefab nesting cycles at "${child.prefab.assetId}" (${[...context.nestingStack, child.prefab.assetId].join(' -> ')})`,
          { path: `/nodes/${stored.nodeId}/children/${child.instanceId}`, reference: child.prefab },
        ),
      );
      continue;
    }
    const nestedResolved = resolveInContext(child.prefab, context);
    if (!nestedResolved) continue;

    context.issues.push(
      ...applyComponentOverrides(nestedResolved, child.overrides, child.prefab),
    );
    markNested(nestedResolved);
    nestedResolved.transform = composeTransforms(child.transform, nestedResolved.transform);
    reparent(nestedResolved, `${resolved.nodePath}/${child.instanceId}`);
    resolved.children.push(nestedResolved);
  }
}

function markNested(node: ResolvedPrefabNode): void {
  node.nested = true;
  for (const child of node.children) markNested(child);
}

function reparent(node: ResolvedPrefabNode, nodePath: string): void {
  node.nodePath = nodePath;
  for (const child of node.children) reparent(child, `${nodePath}/${child.nodeId}`);
}

function resolveInContext(
  reference: GameObjectPrefabReference,
  context: ResolveContext,
): ResolvedPrefabNode | undefined {
  context.nestingStack.push(reference.assetId);
  const root = resolvePayload(reference, context, [reference.assetId]);
  if (root) {
    // Nesting is expanded against the *stored* tree of whichever document
    // actually carries a root: a variant has none of its own, so its nested
    // instances are the ones it inherited, already present in `root`.
    const storedRoot = storedRootOf(reference, context);
    if (storedRoot) expandNested(storedRoot, root, context);
    collectDependencies(root, context.dependencies);
  }
  context.nestingStack.pop();
  return root;
}

/** The stored tree a resolved payload came from, walking a variant chain up. */
function storedRootOf(
  reference: GameObjectPrefabReference,
  context: ResolveContext,
): PrefabNodeDefinition | undefined {
  let current: GameObjectPrefabReference | undefined = reference;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.assetId)) return undefined;
    seen.add(current.assetId);
    const asset: GameObjectPrefabAsset | undefined = context.registry.find(current);
    if (!asset) return undefined;
    if (prefabHasStoredRoot(asset)) return asset.root;
    current = asset.derivation.parent;
  }
  return undefined;
}

/**
 * One Prefab, fully resolved.
 *
 * Issues are returned rather than thrown so a caller rendering an Inspector can
 * show a half-broken Prefab *and* say what is wrong with it. A caller about to
 * run a simulation checks for errors first; `loadResolvedPrefab` in the harness
 * is the example.
 */
export function resolveGameObjectPrefab(
  registry: PrefabAssetRegistry,
  reference: GameObjectPrefabReference,
): PrefabResolution {
  const context: ResolveContext = {
    registry,
    nestingStack: [],
    issues: [],
    dependencies: new Map(),
  };
  const root = resolveInContext(reference, context);
  const asset = registry.find(reference);

  const fallbackRoot: ResolvedPrefabNode = {
    nodeId: 'root',
    nodePath: 'root',
    displayName: reference.assetId,
    enabled: false,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
    },
    components: [],
    children: [],
    sourcePrefab: reference,
    nested: false,
  };

  const dependencies = [...context.dependencies.values()].sort((a, b) =>
    dependencyKey(a).localeCompare(dependencyKey(b)),
  );

  return {
    prefab: {
      reference,
      id: reference.assetId,
      displayName: asset?.metadata.displayName ?? reference.assetId,
      abstract: asset?.abstract ?? false,
      root: root ?? fallbackRoot,
      dependencies,
    },
    issues: context.issues,
  };
}

/** Every node of a resolved Prefab, in deterministic traversal order (§9.7). */
export function walkResolvedNodes(root: ResolvedPrefabNode): ResolvedPrefabNode[] {
  const out: ResolvedPrefabNode[] = [];
  const visit = (node: ResolvedPrefabNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

/** Every component of a resolved Prefab, root first, declaration order within a node. */
export function resolvedComponents(root: ResolvedPrefabNode): GameObjectComponentDefinition[] {
  return walkResolvedNodes(root).flatMap((node) => node.components);
}
