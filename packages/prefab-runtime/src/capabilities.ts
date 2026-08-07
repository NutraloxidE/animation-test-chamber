/**
 * What a resolved Prefab can *do*, as a flat description (§8.5, §9).
 *
 * The Scene operation engine has to refuse several things a schema cannot see:
 *
 *   set_active_camera        on an object whose Prefab has no Camera Component
 *   set_instance_binding     of a character intent with no CharacterMotor to drive
 *   set_relation             naming a camera target on an object with no Camera
 *   set_component_override   addressing a node/Component the Prefab does not have
 *
 * Every one of those is a question about the *resolved* Prefab — after variant
 * patches, after nested Prefabs, after overrides — so answering it needs the
 * registry and the resolver. This file is the one place that resolution is
 * flattened into an answer, so the operation engine, the API and the editor
 * cannot each grow their own slightly different version of "does it have a
 * camera".
 *
 * Deliberately a plain data structure rather than a live handle on the resolved
 * tree. The engine that consumes it is pure and must stay that way; handing it
 * something it could resolve *again* would give it a second answer to reach for.
 */
import type { GameObjectPrefabReference } from '@atc/schema';
import { componentOfType, prefabReferenceKey } from '@atc/schema';
import type { PrefabAssetRegistry } from './registry.ts';
import { resolveGameObjectPrefab, resolvedComponents, walkResolvedNodes } from './resolution.ts';

/** One node of a resolved Prefab, reduced to the ids an override may address. */
export interface PrefabNodeCapability {
  nodeId: string;
  displayName: string;
  /** Component ids on *this* node. Not the subtree's — an override targets a node. */
  componentIds: string[];
  /** Component type per id, so a refusal can say what the target actually is. */
  componentTypes: Record<string, string>;
}

export interface PrefabCapabilities {
  reference: GameObjectPrefabReference;
  displayName: string;
  /** An abstract Prefab may not be placed at all (§5.9). */
  abstract: boolean;
  hasCamera: boolean;
  hasCharacterMotor: boolean;
  hasAnimator: boolean;
  hasModel: boolean;
  hasLight: boolean;
  nodes: PrefabNodeCapability[];
  /** True when the resolution produced an error, so callers can refuse early. */
  resolvable: boolean;
}

/**
 * A capability lookup over a registry, memoized per exact reference.
 *
 * Memoized because one Apply may touch many objects standing on one Prefab, and
 * resolution is not free. Keyed on the *exact* reference — id, version and
 * content hash — so two versions of one Prefab can never share an answer, which
 * is the whole reason references are exact in the first place.
 */
export function prefabCapabilityLookup(
  registry: PrefabAssetRegistry,
): (reference: GameObjectPrefabReference) => PrefabCapabilities | undefined {
  const cache = new Map<string, PrefabCapabilities | undefined>();
  return (reference) => {
    // The content hash is part of the key, not just the id and version:
    // `prefabReferenceKey` stops at `type:id@version`, and two references that
    // agree there and disagree on the hash are exactly the case the
    // exact-reference contract exists to catch.
    const key = `${prefabReferenceKey(reference)}#${reference.contentHash}`;
    if (cache.has(key)) return cache.get(key);
    const described = describePrefabCapabilities(registry, reference);
    cache.set(key, described);
    return described;
  };
}

/**
 * One Prefab's capabilities, or `undefined` when the registry does not have it.
 *
 * `undefined` and "resolvable: false" are different answers and both matter: the
 * first means the Scene names a Prefab version the repository no longer holds,
 * the second means it holds it and it does not resolve. A caller that collapsed
 * them would tell someone to re-publish an asset that is already there.
 */
export function describePrefabCapabilities(
  registry: PrefabAssetRegistry,
  reference: GameObjectPrefabReference,
): PrefabCapabilities | undefined {
  if (!registry.has(reference)) return undefined;
  const resolution = resolveGameObjectPrefab(registry, reference);
  const components = resolvedComponents(resolution.prefab.root);

  return {
    reference,
    displayName: resolution.prefab.displayName,
    abstract: resolution.prefab.abstract,
    hasCamera: componentOfType(components, 'camera') !== undefined,
    hasCharacterMotor: componentOfType(components, 'character-motor') !== undefined,
    hasAnimator: componentOfType(components, 'animator') !== undefined,
    hasModel: componentOfType(components, 'model-renderer') !== undefined,
    hasLight: componentOfType(components, 'light') !== undefined,
    nodes: walkResolvedNodes(resolution.prefab.root).map((node) => ({
      nodeId: node.nodeId,
      displayName: node.displayName,
      componentIds: node.components.map((component) => component.componentId),
      componentTypes: Object.fromEntries(
        node.components.map((component) => [component.componentId, component.componentType]),
      ),
    })),
    resolvable: !resolution.issues.some((issue) => issue.severity === 'error'),
  };
}
