/**
 * The generated library index (PLAN 30, 37).
 *
 * A static host has no API and no filesystem, but the plan still requires the
 * Asset Library to browse, search, preview and diff there. So the index carries
 * whole asset documents, not just summaries: with them the browser can run the
 * same resolver the server runs, and "degrades explicitly" means losing the
 * ability to *write*, not the ability to look.
 *
 * It is a generated artifact. Nothing reads it as canonical — the harness
 * rebuilds it from `assets/animation/**` and fails if it has drifted.
 */
import type { AnimationAssetSummary } from '@atc/schema';
import { AnimationAssetRegistry, type StoredAsset } from './registry.ts';
import { canonicalJson, sha256Hex } from './hashing.ts';

export interface AnimationAssetLibraryIndex {
  schemaVersion: number;
  /** Hash of the asset payload. Changes exactly when an asset changes. */
  indexHash: string;
  assets: StoredAsset[];
  summaries: AnimationAssetSummary[];
}

/**
 * Deliberately timestamp-free. A `generatedAt` would make the file differ on
 * every run, so every commit would carry a spurious diff and the harness could
 * never tell "the index is stale" from "the index was regenerated".
 */
export function buildLibraryIndex(registry: AnimationAssetRegistry): AnimationAssetLibraryIndex {
  const assets = registry.all();
  const unsealed = assets.filter((asset) => asset.document.metadata.contentHash === '');
  if (unsealed.length > 0) {
    throw new Error(
      `unsealed-published-asset: the library index cannot include a draft: ` +
        unsealed.map((asset) => `${asset.assetType}:${asset.id}@${asset.version}`).join(', '),
    );
  }
  return {
    schemaVersion: 2,
    indexHash: sha256Hex(canonicalJson(assets)),
    assets,
    summaries: registry.summaries(),
  };
}

export function registryFromLibraryIndex(
  index: AnimationAssetLibraryIndex,
): AnimationAssetRegistry {
  return new AnimationAssetRegistry(index.assets);
}

export function libraryIndexIsCurrent(
  index: AnimationAssetLibraryIndex,
  registry: AnimationAssetRegistry,
): boolean {
  return index.indexHash === sha256Hex(canonicalJson(registry.all()));
}
