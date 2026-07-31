/**
 * The asset registry (PLAN 30).
 *
 * Deliberately source-agnostic: it is handed documents, never a directory. The
 * harness fills it from `assets/animation/**`, the browser fills it from the
 * generated library index, and neither of them leaks a file path into anything
 * downstream. That is what lets the same resolution code run in a Vitest
 * process, in the API server and on a static host.
 */
import type {
  AnimationAsset,
  AnimationAssetSummary,
  AnimationAssetType,
  AnimationBehaviorAsset,
  AnimationClipAsset,
  AnimationMotionSetAsset,
  AnimationTuningProfileAsset,
  AssetIssue,
  AssetReference,
  AssetValidationReport,
  HumanoidRigProfileAsset,
} from '@atc/schema';
import { compareAssetVersions, referenceKey, validateAgainst } from '@atc/schema';
import { assetHashMatches, computeContentHash } from './hashing.ts';

export interface StoredAsset {
  assetType: AnimationAssetType;
  id: string;
  version: string;
  document: AnimationAsset;
}

export interface AssetFilter {
  assetType?: AnimationAssetType;
  tag?: string;
  text?: string;
  derivation?: 'base' | 'variant' | 'fork';
  onlyInvalid?: boolean;
}

const SCHEMA_NAME_BY_TYPE = {
  'animation-behavior': 'AnimationBehaviorAsset',
  'animation-motion-set': 'AnimationMotionSetAsset',
  'animation-clip': 'AnimationClipAsset',
  'humanoid-rig': 'HumanoidRigProfileAsset',
  'animation-tuning': 'AnimationTuningProfileAsset',
} as const;

function derivationOf(asset: AnimationAsset): 'base' | 'variant' | 'fork' {
  const derivation = (asset as AnimationBehaviorAsset).derivation;
  return derivation?.mode ?? 'base';
}

/** Terms the browser-side search matches against (PLAN 24.5). */
function searchTermsOf(asset: AnimationAsset): string[] {
  const terms = new Set<string>([
    asset.metadata.id,
    asset.metadata.displayName,
    asset.metadata.description,
    ...asset.metadata.tags,
  ]);
  const behavior = asset as AnimationBehaviorAsset;
  for (const slot of behavior.motionSlots ?? []) terms.add(slot.id);
  for (const state of behavior.graph?.states ?? []) {
    terms.add(state.id);
    terms.add(state.motionSlot);
  }
  for (const contract of behavior.semanticEvents ?? []) terms.add(contract.kind);
  const motionSet = asset as AnimationMotionSetAsset;
  for (const binding of motionSet.bindings ?? []) {
    terms.add(binding.motionSlot);
    terms.add(binding.clip.assetId);
  }
  for (const event of (asset as AnimationClipAsset).clip?.events ?? []) terms.add(event.kind);
  return [...terms].filter((term) => term.length > 0);
}

export class AnimationAssetRegistry {
  /** `type:id@version` -> asset. */
  private readonly byKey = new Map<string, StoredAsset>();
  /** `type:id` -> versions, ascending. */
  private readonly versions = new Map<string, string[]>();

  constructor(assets: readonly StoredAsset[] = []) {
    for (const asset of assets) this.add(asset);
  }

  /**
   * Registers one asset version. Throws rather than silently overwriting
   * (PLAN Part III §18) — a caller building a registry from disk plus a
   * proposed transaction has already guaranteed these keys are disjoint (the
   * transaction engine refuses a `create` write whose target exists), so two
   * `StoredAsset`s landing on the same key here is an integrity bug in the
   * caller, not a normal outcome to validate around. Likewise a wrapper whose
   * assetType/id/version disagrees with the document's own metadata means the
   * asset was loaded from the wrong place — real data never does this.
   */
  add(asset: StoredAsset): void {
    const key = `${asset.assetType}:${asset.id}@${asset.version}`;
    if (this.byKey.has(key)) {
      throw new Error(`duplicate-asset-key: ${key} was registered more than once`);
    }
    const metadata = asset.document.metadata;
    if (
      metadata.assetType !== asset.assetType ||
      metadata.id !== asset.id ||
      metadata.version !== asset.version
    ) {
      throw new Error(
        `asset-metadata-mismatch: ${key} wrapper disagrees with document metadata ` +
          `(${metadata.assetType}:${metadata.id}@${metadata.version})`,
      );
    }
    this.byKey.set(key, asset);
    const lineage = `${asset.assetType}:${asset.id}`;
    const known = this.versions.get(lineage) ?? [];
    if (!known.includes(asset.version)) {
      known.push(asset.version);
      known.sort(compareAssetVersions);
      this.versions.set(lineage, known);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  all(): StoredAsset[] {
    return [...this.byKey.values()].sort((a, b) =>
      `${a.assetType}:${a.id}@${a.version}`.localeCompare(`${b.assetType}:${b.id}@${b.version}`),
    );
  }

  versionsOf(assetType: AnimationAssetType, assetId: string): string[] {
    return [...(this.versions.get(`${assetType}:${assetId}`) ?? [])];
  }

  latestVersion(assetType: AnimationAssetType, assetId: string): string | undefined {
    return this.versionsOf(assetType, assetId).at(-1);
  }

  has(reference: AssetReference): boolean {
    return this.byKey.has(referenceKey(reference));
  }

  /** The stored asset, or undefined. Use `get` when a missing asset is a bug. */
  find(reference: AssetReference): AnimationAsset | undefined {
    return this.byKey.get(referenceKey(reference))?.document;
  }

  get(reference: AssetReference): AnimationAsset {
    const found = this.find(reference);
    if (!found) throw new Error(`asset not found: ${referenceKey(reference)}`);
    return found;
  }

  getBehavior(reference: AssetReference): AnimationBehaviorAsset {
    return this.get(reference) as AnimationBehaviorAsset;
  }

  getMotionSet(reference: AssetReference): AnimationMotionSetAsset {
    return this.get(reference) as AnimationMotionSetAsset;
  }

  getClip(reference: AssetReference): AnimationClipAsset {
    return this.get(reference) as AnimationClipAsset;
  }

  getRig(reference: AssetReference): HumanoidRigProfileAsset {
    return this.get(reference) as HumanoidRigProfileAsset;
  }

  getTuning(reference: AssetReference): AnimationTuningProfileAsset {
    return this.get(reference) as AnimationTuningProfileAsset;
  }

  /** Is this lineage/version known at all — no hash opinion either way. */
  private checkLineage(reference: Pick<AssetReference, 'assetType' | 'assetId' | 'version'>): AssetIssue[] {
    const lineage = this.versions.get(`${reference.assetType}:${reference.assetId}`);
    if (!lineage || lineage.length === 0) {
      return [
        {
          code: 'missing-reference',
          severity: 'error',
          message: `no asset "${reference.assetId}" of type ${reference.assetType} exists`,
          reference: reference as AssetReference,
        },
      ];
    }
    if (!lineage.includes(reference.version)) {
      return [
        {
          code: 'version-not-found',
          severity: 'error',
          message: `${reference.assetId} has no version ${reference.version} (have ${lineage.join(', ')})`,
          reference: reference as AssetReference,
        },
      ];
    }
    return [];
  }

  /**
   * Why a reference cannot be honoured, in the order a reader would ask: is
   * the lineage known, is the version there, does the content still match.
   *
   * The hash comparison has no bypass (PLAN Part III §18): every real
   * `AssetReference` carries a `PublishedContentHash`, which the schema
   * guarantees is never empty, so there is no "the caller didn't know the
   * hash yet" case here to make room for.
   */
  checkReference(reference: AssetReference): AssetIssue[] {
    const lineageIssues = this.checkLineage(reference);
    if (lineageIssues.length > 0) return lineageIssues;

    const asset = this.get(reference);
    const actual = computeContentHash(asset);
    if (reference.contentHash !== actual) {
      return [
        {
          code: 'hash-mismatch',
          severity: 'error',
          message:
            `${reference.assetId}@${reference.version} has been modified since it was referenced ` +
            `(expected ${reference.contentHash.slice(0, 12)}, found ${actual.slice(0, 12)})`,
          reference,
        },
      ];
    }
    return [];
  }

  /**
   * Schema validity plus self-consistency of the stored hash. Unlike
   * `checkReference`, this is not checking an incoming reference's claimed
   * hash against reality — callers here (library summaries, the audit pass
   * checking an asset against itself) only have assetType/id/version, no
   * opinion on the hash, so this never compares one.
   */
  validate(reference: AssetReference): AssetValidationReport {
    const issues = this.checkLineage(reference);
    if (issues.length > 0) return { valid: false, issues };

    const asset = this.get(reference);
    const schemaResult = validateAgainst(SCHEMA_NAME_BY_TYPE[reference.assetType], asset);
    for (const issue of schemaResult.issues) {
      issues.push({
        code: 'schema-invalid',
        severity: 'error',
        message: `${issue.path} ${issue.message}`,
        path: issue.path,
        reference,
      });
    }
    if (asset.metadata.contentHash !== '' && !assetHashMatches(asset)) {
      issues.push({
        code: 'published-asset-modified',
        severity: 'error',
        message: `${reference.assetId}@${reference.version} does not match its own contentHash`,
        reference,
      });
    }
    return { valid: issues.length === 0, issues };
  }

  /** A reference to a stored asset, with its hash filled in from the content. */
  referenceTo(assetType: AnimationAssetType, assetId: string, version: string): AssetReference {
    const stored = this.byKey.get(`${assetType}:${assetId}@${version}`);
    if (!stored) throw new Error(`asset not found: ${assetType}:${assetId}@${version}`);
    return {
      assetType,
      assetId,
      version,
      contentHash: computeContentHash(stored.document),
    };
  }

  summaries(filter: AssetFilter = {}): AnimationAssetSummary[] {
    const text = filter.text?.trim().toLowerCase();
    return this.all()
      .map((stored) => {
        const report = this.validate({
          assetType: stored.assetType,
          assetId: stored.id,
          version: stored.version,
          contentHash: '',
        });
        return {
          assetType: stored.assetType,
          id: stored.id,
          version: stored.version,
          contentHash: computeContentHash(stored.document),
          displayName: stored.document.metadata.displayName,
          description: stored.document.metadata.description,
          tags: stored.document.metadata.tags,
          derivation: derivationOf(stored.document),
          protectionLevel: stored.document.metadata.protection?.level ?? 'editable',
          searchTerms: searchTermsOf(stored.document),
          valid: report.valid,
          issueCodes: [...new Set(report.issues.map((issue) => issue.code))],
        } satisfies AnimationAssetSummary;
      })
      .filter((summary) => {
        if (filter.assetType && summary.assetType !== filter.assetType) return false;
        if (filter.tag && !summary.tags.includes(filter.tag)) return false;
        if (filter.derivation && summary.derivation !== filter.derivation) return false;
        if (filter.onlyInvalid && summary.valid) return false;
        if (text) {
          const haystack = summary.searchTerms.join(' ').toLowerCase();
          if (!haystack.includes(text)) return false;
        }
        return true;
      });
  }
}
