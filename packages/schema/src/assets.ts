/**
 * The primitives every versioned repository asset shares.
 *
 * These lived inside `animation-assets.ts` because animation assets were the
 * only versioned assets in the repository. They are not animation concepts —
 * a semantic version, a content hash and a canonical patch say nothing about
 * motion — and a second asset family (GameObject Prefabs, work package §4)
 * that reimplemented them would be a second definition of "immutable after
 * publication", free to drift from the first.
 *
 * So they move here, and `animation-assets.ts` re-exports them: no existing
 * import changes, and there is exactly one answer to "what is a version" for
 * every asset family that will ever exist.
 *
 * What deliberately does *not* live here is a universal `AssetReference`
 * (§4.2). A reference names an asset *type*, and widening the animation
 * resolver's reference type to also admit a Prefab would make "resolve this
 * behaviour" a function that has to check at runtime whether it was handed a
 * Prefab. Each family declares its own reference; `RepositoryAssetReference`
 * in `prefab.ts` unions them only for the cross-asset tooling that genuinely
 * needs both.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { ProtectionMetadata, SchemaVersion, ValueProvenance } from './common.ts';

/** SemVer, exactly three numeric components. Asset files are named after it. */
export const AssetVersion = Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$' });

/**
 * Lowercase hex SHA-256 of a *published* asset version. Never empty: a
 * reference with no hash is indistinguishable from one nobody checked, which
 * is exactly the bypass PLAN Part III closes. Anything that points at a
 * published asset — `AssetReference`, `GameObjectPrefabReference`, a
 * character's animation assignment, a motion set binding, a variant's parent —
 * carries this type.
 */
export const PublishedContentHash = Type.String({ pattern: '^[a-f0-9]{64}$' });

/**
 * Lowercase hex SHA-256, or the empty string on a draft that has not been
 * sealed yet. Only asset *metadata* uses this — an asset still being authored
 * in memory or inside a prepared transaction view has no hash until
 * `sealAsset()` computes one, and that is fine precisely because nothing else
 * has been allowed to reference it yet.
 */
export const DraftContentHash = Type.String({ pattern: '^([a-f0-9]{64})?$' });

/**
 * A single override addressed by canonical path, relative to the asset it
 * patches. `remove` is what lets a variant drop a state without copying the
 * parent; `value` is ignored for it.
 */
export const CanonicalPatch = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    op: Type.Union([Type.Literal('set'), Type.Literal('append'), Type.Literal('remove')]),
    value: Type.Optional(Type.Unknown()),
    reason: Type.Optional(Type.String()),
    provenance: Type.Optional(ValueProvenance),
  },
  { $id: 'CanonicalPatch', additionalProperties: false },
);
export type CanonicalPatch = Static<typeof CanonicalPatch>;

/**
 * Where a derived asset came from, for one asset family's reference type.
 *
 * A function rather than a constant because provenance points *at an asset*,
 * and which asset type that is differs per family: a Prefab is forked from a
 * Prefab, never from a motion set. Sharing the field names while keeping the
 * reference type exact is the whole point — a single `AssetDerivationProvenance`
 * carrying a widened reference would let a Prefab claim to have been forked
 * from a clip, which no code could then reject.
 */
export function assetDerivationProvenanceFields<T extends TSchema>(reference: T) {
  return {
    forkedFrom: Type.Optional(reference),
    duplicatedFrom: Type.Optional(reference),
    promotedFromCandidateId: Type.Optional(Type.String()),
    migratedFromSchemaVersion: Type.Optional(SchemaVersion),
    note: Type.Optional(Type.String()),
  } as const;
}

/**
 * The metadata fields every published asset version carries (§4.1).
 *
 * Returned as a spreadable fragment rather than a finished object so each
 * family can pin its own `assetType` literal while the *shape* — and therefore
 * what `computeContentHash` blanks out, and what `ProtectionMetadata` governs —
 * stays identical across families.
 *
 * Key order is load-bearing in one narrow sense: `schemas/*.schema.json` is a
 * generated artifact compared byte-for-byte by `harness:check`, and object key
 * order survives `JSON.stringify`. It is not load-bearing for hashing —
 * `canonicalJson` sorts keys — so a reordering here is a generated-file diff,
 * never a silent reference break.
 */
export function assetMetadataFields<
  TAssetType extends TSchema,
  TId extends TSchema,
  TProvenance extends TSchema,
>(options: { assetType: TAssetType; id: TId; assetProvenance: TProvenance }) {
  return {
    schemaVersion: SchemaVersion,
    assetType: options.assetType,
    id: options.id,
    version: AssetVersion,
    displayName: Type.String(),
    description: Type.String(),
    tags: Type.Array(Type.String()),
    createdAt: Type.String(),
    createdBy: Type.String(),
    /** SHA-256 of this document with `contentHash` itself blanked out. Empty until sealed. */
    contentHash: DraftContentHash,
    protection: Type.Optional(ProtectionMetadata),
    provenance: Type.Optional(ValueProvenance),
    assetProvenance: Type.Optional(options.assetProvenance),
  } as const;
}

export const NEW_ASSET_VERSION = '1.0.0';

export function parseAssetVersion(version: string): [number, number, number] {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`not a semantic version: "${version}"`);
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function compareAssetVersions(left: string, right: string): number {
  const a = parseAssetVersion(left);
  const b = parseAssetVersion(right);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

export function bumpAssetVersion(version: string, level: 'major' | 'minor' | 'patch'): string {
  const [major, minor, patch] = parseAssetVersion(version);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
