/**
 * Creating a Prefab version from another one (§5.7).
 *
 * Three modes, and the difference between them is what gets *stored*:
 *
 *   base     authored outright; stores a root.
 *   variant  stores a parent reference and patches, never a copy — so a fix in
 *            the parent reaches every variant that has not overridden it.
 *   fork     stores a full snapshot plus provenance, and never reads the parent
 *            again — so deleting the parent is harmless.
 *
 * Publishing a version is not adoption (§14.1). Nothing here re-points a Scene
 * or another Prefab at what it produces; that is a separate, explicitly
 * targeted request.
 */
import type {
  BaseGameObjectPrefabAsset,
  ForkGameObjectPrefabAsset,
  GameObjectPrefabAsset,
  GameObjectPrefabMetadata,
  GameObjectPrefabReference,
  PrefabNodeDefinition,
  PrefabPatch,
  VariantGameObjectPrefabAsset,
} from '@atc/schema';
import { GAME_OBJECT_PREFAB_ASSET_TYPE, NEW_ASSET_VERSION, bumpAssetVersion } from '@atc/schema';
import { sealAsset } from '@atc/animation-asset-runtime';

export interface PrefabAuthoring {
  id: string;
  displayName: string;
  description: string;
  tags: string[];
  createdAt: string;
  createdBy: string;
  version?: string;
  abstract?: boolean;
}

function metadataOf(
  authoring: PrefabAuthoring,
  assetProvenance?: GameObjectPrefabMetadata['assetProvenance'],
): GameObjectPrefabMetadata {
  return {
    schemaVersion: 1,
    assetType: GAME_OBJECT_PREFAB_ASSET_TYPE,
    id: authoring.id,
    version: authoring.version ?? NEW_ASSET_VERSION,
    displayName: authoring.displayName,
    description: authoring.description,
    tags: authoring.tags,
    createdAt: authoring.createdAt,
    createdBy: authoring.createdBy,
    contentHash: '',
    ...(assetProvenance ? { assetProvenance } : {}),
  };
}

/** A base Prefab, sealed. */
export function createBasePrefab(
  authoring: PrefabAuthoring,
  root: PrefabNodeDefinition,
): BaseGameObjectPrefabAsset {
  return sealAsset({
    metadata: metadataOf(authoring),
    derivation: { mode: 'base' },
    abstract: authoring.abstract ?? false,
    root,
  } satisfies BaseGameObjectPrefabAsset);
}

/** A variant of `parent`, storing only what it changes. */
export function createPrefabVariant(
  authoring: PrefabAuthoring,
  parent: GameObjectPrefabReference,
  patches: readonly PrefabPatch[],
): VariantGameObjectPrefabAsset {
  return sealAsset({
    metadata: metadataOf(authoring),
    derivation: { mode: 'variant', parent, patches: [...patches] },
    abstract: authoring.abstract ?? false,
  } satisfies VariantGameObjectPrefabAsset);
}

/** A detached snapshot of `root`, remembering where it came from. */
export function createPrefabFork(
  authoring: PrefabAuthoring,
  forkedFrom: GameObjectPrefabReference,
  forkIntent: string,
  root: PrefabNodeDefinition,
): ForkGameObjectPrefabAsset {
  return sealAsset({
    metadata: metadataOf(authoring, { forkedFrom }),
    derivation: { mode: 'fork', forkedFrom, forkIntent },
    abstract: authoring.abstract ?? false,
    root,
  } satisfies ForkGameObjectPrefabAsset);
}

/**
 * The next version of a Prefab, with the same payload.
 *
 * Publishing is how a Prefab changes (§3.4): a published version is immutable
 * and content-hashed, so "edit the Prefab" means "publish 1.0.1", never
 * "rewrite 1.0.0.json".
 */
export function nextPrefabVersion(
  asset: GameObjectPrefabAsset,
  level: 'major' | 'minor' | 'patch' = 'patch',
): GameObjectPrefabAsset {
  const version = bumpAssetVersion(asset.metadata.version, level);
  return sealAsset({
    ...asset,
    metadata: { ...asset.metadata, version, contentHash: '' },
  } as GameObjectPrefabAsset);
}
