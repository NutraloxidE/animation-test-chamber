/**
 * Route-to-Prefab resolution, and the legacy Rig redirect (§4).
 *
 * The same negative rule the Rig Editor's resolver was built around, moved to
 * the surface that replaces it: `/edit/prefab/a` must never open Prefab `b`,
 * and an id that names nothing must produce a not-found rather than the first
 * Prefab in the registry. "Fall back to something so the page renders" is the
 * most plausible-looking way to break that — every panel looks right, and the
 * human is editing the wrong asset.
 *
 * The route names an *id*, not a version. The editor opens the latest version
 * of that lineage, which is the only choice that keeps a bookmark useful after
 * a publish; anything version-exact is addressed through Usage, where the
 * exactness is the point.
 *
 * Pure and React-free — "this id resolves to exactly this Prefab, or to
 * nothing" needs no DOM to assert.
 */
import type { GameObjectPrefabAsset, GameObjectPrefabReference } from '@atc/schema';
import { prefabIdForLegacyCharacterId } from '@atc/schema';
import type { PrefabAssetRegistry, PrefabSummary } from '@atc/prefab-runtime';

export type PrefabEditorTarget =
  | {
      status: 'resolved';
      prefabId: string;
      version: string;
      reference: GameObjectPrefabReference;
      document: GameObjectPrefabAsset;
    }
  | { status: 'missing'; prefabId: string; available: PrefabSummary[] }
  | { status: 'no-target'; available: PrefabSummary[] };

export function resolvePrefabEditorTarget(
  registry: PrefabAssetRegistry,
  prefabId: string | null,
): PrefabEditorTarget {
  const available = registry.summaries();
  if (prefabId === null) return { status: 'no-target', available };

  // Exact id match only. No prefix matching, no case folding, no "closest" —
  // each turns a typo into a successful edit of the wrong Prefab.
  const version = registry.latestVersion(prefabId);
  if (version === undefined) return { status: 'missing', prefabId, available };

  const reference = registry.referenceTo(prefabId, version);
  return {
    status: 'resolved',
    prefabId,
    version,
    reference,
    document: registry.get(reference),
  };
}

/**
 * Where `/edit/rig/:legacyCharacterId` sends someone (§4).
 *
 * Deterministic, and derived from the same table the migration used — a second
 * mapping would let a bookmark resolve to a different Prefab than the one the
 * Character actually became. A legacy id with no mapping resolves to `null`,
 * which is a not-found: sending it to "some Prefab" would be the fallback this
 * whole file exists to refuse.
 */
export function prefabRedirectForLegacyCharacterId(
  registry: PrefabAssetRegistry,
  characterId: string | null,
): string | null {
  if (characterId === null) return null;
  const prefabId = prefabIdForLegacyCharacterId(characterId) ?? characterId;
  return registry.latestVersion(prefabId) === undefined ? null : prefabId;
}

/**
 * What this Prefab derives from, whichever way it derives.
 *
 * A variant names its `parent`; a fork names what it `forkedFrom`. They are
 * different relationships — a variant still resolves through its parent, a fork
 * has cut that tie — and the one thing both answer is "where did this come
 * from", which is what the Overview and the Version panel display.
 */
export function prefabParentReference(
  document: GameObjectPrefabAsset,
): GameObjectPrefabReference | undefined {
  const derivation = document.derivation;
  if (derivation.mode === 'variant') return derivation.parent;
  if (derivation.mode === 'fork') return derivation.forkedFrom;
  return undefined;
}
