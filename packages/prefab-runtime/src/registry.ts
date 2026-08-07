/**
 * The Prefab asset registry (§8).
 *
 * Source-agnostic in exactly the way `AnimationAssetRegistry` is: it is handed
 * documents, never a directory. The harness fills it from `assets/prefabs/**`,
 * the browser fills it from the generated index, and neither leaks a file path
 * downstream — which is what lets one resolver run in Vitest, in the API server
 * and on a static host.
 */
import type {
  GameObjectPrefabAsset,
  GameObjectPrefabReference,
  RepositoryAssetReference,
} from '@atc/schema';
import { compareAssetVersions, prefabHasStoredRoot, prefabReferenceKey } from '@atc/schema';
import { computeContentHash } from '@atc/animation-asset-runtime';
import { type PrefabIssue, type PrefabValidationReport, prefabError } from './issues.ts';
import type { GameplayScriptRegistry } from '@atc/gameplay-sdk';
import {
  nestedPrefabReferences,
  referenceOf,
  validatePrefabDocument,
  walkStoredNodes,
} from './validation.ts';

export interface StoredPrefab {
  id: string;
  version: string;
  document: GameObjectPrefabAsset;
}

export interface PrefabSummary {
  id: string;
  version: string;
  contentHash: string;
  displayName: string;
  description: string;
  tags: string[];
  derivation: 'base' | 'variant' | 'fork';
  abstract: boolean;
  /** Component types on the *stored* payload; a variant reports its parent's at resolve time. */
  componentTypes: string[];
  protectionLevel: string;
  searchTerms: string[];
  valid: boolean;
  issueCodes: string[];
}

export interface PrefabFilter {
  tag?: string;
  text?: string;
  derivation?: 'base' | 'variant' | 'fork';
  onlyPlaceable?: boolean;
  onlyInvalid?: boolean;
}

function searchTermsOf(asset: GameObjectPrefabAsset): string[] {
  const terms = new Set<string>([
    asset.metadata.id,
    asset.metadata.displayName,
    asset.metadata.description,
    ...asset.metadata.tags,
  ]);
  if (prefabHasStoredRoot(asset)) {
    for (const node of walkStoredNodes(asset.root)) {
      terms.add(node.nodeId);
      terms.add(node.displayName);
      for (const component of node.components) {
        terms.add(component.componentType);
        terms.add(component.componentId);
        if (component.componentType === 'tags') for (const tag of component.tags) terms.add(tag);
        if (component.componentType === 'model-renderer') {
          terms.add(
            component.model.kind === 'procedural-humanoid'
              ? component.model.presetId
              : component.model.assetPath,
          );
        }
        if (component.componentType === 'animator') {
          terms.add(component.assignment.behavior.assetId);
          terms.add(component.assignment.motionSet.assetId);
          terms.add(component.assignment.rig.assetId);
        }
      }
    }
  } else {
    terms.add(asset.derivation.parent.assetId);
  }
  return [...terms].filter((term) => term.length > 0);
}

function componentTypesOf(asset: GameObjectPrefabAsset): string[] {
  if (!prefabHasStoredRoot(asset)) return [];
  const types = new Set<string>();
  for (const node of walkStoredNodes(asset.root)) {
    for (const component of node.components) types.add(component.componentType);
  }
  return [...types].sort();
}

export class PrefabAssetRegistry {
  /** `id@version` -> prefab. */
  private readonly byKey = new Map<string, StoredPrefab>();
  /** `id` -> versions, ascending. */
  private readonly versions = new Map<string, string[]>();

  constructor(prefabs: readonly StoredPrefab[] = [], private readonly gameplayRegistry?: GameplayScriptRegistry) {
    for (const prefab of prefabs) this.add(prefab);
  }

  /**
   * Registers one Prefab version. Throws rather than silently overwriting, for
   * the same reason the animation registry does: a caller building a registry
   * from disk plus a proposed transaction has already guaranteed the keys are
   * disjoint, so a collision here is an integrity bug in the caller rather than
   * a normal outcome to validate around.
   */
  add(prefab: StoredPrefab): void {
    const key = `${prefab.id}@${prefab.version}`;
    if (this.byKey.has(key)) {
      throw new Error(`duplicate-prefab-key: ${key} was registered more than once`);
    }
    const metadata = prefab.document.metadata;
    if (metadata.id !== prefab.id || metadata.version !== prefab.version) {
      throw new Error(
        `prefab-metadata-mismatch: ${key} wrapper disagrees with document metadata ` +
          `(${metadata.id}@${metadata.version})`,
      );
    }
    this.byKey.set(key, prefab);
    const known = this.versions.get(prefab.id) ?? [];
    if (!known.includes(prefab.version)) {
      known.push(prefab.version);
      known.sort(compareAssetVersions);
      this.versions.set(prefab.id, known);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  all(): StoredPrefab[] {
    return [...this.byKey.values()].sort((a, b) =>
      `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`),
    );
  }

  ids(): string[] {
    return [...this.versions.keys()].sort();
  }

  versionsOf(assetId: string): string[] {
    return [...(this.versions.get(assetId) ?? [])];
  }

  latestVersion(assetId: string): string | undefined {
    return this.versionsOf(assetId).at(-1);
  }

  has(reference: GameObjectPrefabReference): boolean {
    return this.byKey.has(`${reference.assetId}@${reference.version}`);
  }

  find(reference: GameObjectPrefabReference): GameObjectPrefabAsset | undefined {
    return this.byKey.get(`${reference.assetId}@${reference.version}`)?.document;
  }

  get(reference: GameObjectPrefabReference): GameObjectPrefabAsset {
    const found = this.find(reference);
    if (!found) throw new Error(`prefab not found: ${prefabReferenceKey(reference)}`);
    return found;
  }

  /** A reference to a stored Prefab, with its hash filled in from the content. */
  referenceTo(assetId: string, version: string): GameObjectPrefabReference {
    const stored = this.byKey.get(`${assetId}@${version}`);
    if (!stored) throw new Error(`prefab not found: ${assetId}@${version}`);
    return {
      assetType: 'game-object-prefab',
      assetId,
      version,
      contentHash: computeContentHash(stored.document),
    };
  }

  /** Is this lineage/version known at all — no hash opinion either way. */
  private checkLineage(reference: GameObjectPrefabReference): PrefabIssue[] {
    const lineage = this.versions.get(reference.assetId);
    if (!lineage || lineage.length === 0) {
      return [
        prefabError('missing-prefab', `no Prefab "${reference.assetId}" exists`, { reference }),
      ];
    }
    if (!lineage.includes(reference.version)) {
      return [
        prefabError(
          'prefab-version-not-found',
          `${reference.assetId} has no version ${reference.version} (have ${lineage.join(', ')})`,
          { reference },
        ),
      ];
    }
    return [];
  }

  /**
   * Why a reference cannot be honoured, in the order a reader would ask: is the
   * lineage known, is the version there, does the content still match.
   *
   * There is no bypass for the hash comparison. Every canonical
   * `GameObjectPrefabReference` carries a `PublishedContentHash`, which the
   * schema guarantees is non-empty, so "the caller did not know the hash yet"
   * is not a case that needs room made for it.
   */
  checkReference(reference: GameObjectPrefabReference): PrefabIssue[] {
    const lineageIssues = this.checkLineage(reference);
    if (lineageIssues.length > 0) return lineageIssues;

    const actual = computeContentHash(this.get(reference));
    if (reference.contentHash !== actual) {
      return [
        prefabError(
          'prefab-hash-mismatch',
          `${reference.assetId}@${reference.version} has been modified since it was referenced ` +
            `(expected ${reference.contentHash.slice(0, 12)}, found ${actual.slice(0, 12)})`,
          { reference },
        ),
      ];
    }
    return [];
  }

  /**
   * Everything wrong with one stored Prefab: its own document, its stored hash,
   * and the neighbours it names.
   */
  validate(reference: GameObjectPrefabReference): PrefabValidationReport {
    const issues = this.checkLineage(reference);
    if (issues.length > 0) return { valid: false, issues };

    const asset = this.get(reference);
    issues.push(...validatePrefabDocument(asset, { gameplayRegistry: this.gameplayRegistry }));
    if (asset.metadata.contentHash !== '' && computeContentHash(asset) !== asset.metadata.contentHash) {
      issues.push(
        prefabError(
          'published-prefab-modified',
          `${reference.assetId}@${reference.version} does not match its own contentHash`,
          { reference },
        ),
      );
    }
    if (asset.metadata.contentHash === '') {
      issues.push(
        prefabError(
          'unsealed-published-prefab',
          `${reference.assetId}@${reference.version} was published without being sealed`,
          { reference },
        ),
      );
    }

    issues.push(...this.checkNeighbours(asset));
    return { valid: issues.every((issue) => issue.severity !== 'error'), issues };
  }

  /** Nested Prefabs and variant parents: exist, hash-match, and do not cycle. */
  private checkNeighbours(asset: GameObjectPrefabAsset): PrefabIssue[] {
    const issues: PrefabIssue[] = [];
    const self = referenceOf(asset);

    if (asset.derivation.mode === 'variant') {
      issues.push(...this.checkReference(asset.derivation.parent));
      const cycle = this.variantCycle(asset.metadata.id);
      if (cycle) {
        issues.push(
          prefabError(
            'variant-parent-cycle',
            `variant chain cycles: ${cycle.join(' -> ')}`,
            { reference: self },
          ),
        );
      }
    }

    if (prefabHasStoredRoot(asset)) {
      for (const nested of nestedPrefabReferences(asset.root)) {
        issues.push(...this.checkReference(nested));
      }
      const cycle = this.nestingCycle(asset.metadata.id);
      if (cycle) {
        issues.push(
          prefabError('nested-prefab-cycle', `nesting cycles: ${cycle.join(' -> ')}`, {
            reference: self,
          }),
        );
      }
    }

    return issues;
  }

  /** The variant chain from `assetId` upward, or the cycle it falls into. */
  private variantCycle(assetId: string): string[] | undefined {
    const seen: string[] = [];
    let current: string | undefined = assetId;
    while (current !== undefined) {
      if (seen.includes(current)) return [...seen, current];
      seen.push(current);
      const version: string | undefined = this.latestVersionOfLineage(current);
      if (version === undefined) return undefined;
      const asset: GameObjectPrefabAsset | undefined = this.byKey.get(`${current}@${version}`)
        ?.document;
      current = asset?.derivation.mode === 'variant' ? asset.derivation.parent.assetId : undefined;
    }
    return undefined;
  }

  /** Whether `assetId` can reach itself through nesting. */
  private nestingCycle(assetId: string): string[] | undefined {
    const path: string[] = [];
    const visit = (id: string): string[] | undefined => {
      if (path.includes(id)) return [...path, id];
      path.push(id);
      const version = this.latestVersionOfLineage(id);
      const asset = version === undefined ? undefined : this.byKey.get(`${id}@${version}`)?.document;
      if (asset && prefabHasStoredRoot(asset)) {
        for (const nested of nestedPrefabReferences(asset.root)) {
          const found = visit(nested.assetId);
          if (found) return found;
        }
      }
      path.pop();
      return undefined;
    };
    return visit(assetId);
  }

  /**
   * Cycle detection walks lineages rather than exact versions on purpose: a
   * cycle that only exists between two *specific* versions is still a cycle
   * someone will hit the moment they publish, and reporting it at the lineage
   * level is what makes the refusal stable across a version bump.
   */
  private latestVersionOfLineage(assetId: string): string | undefined {
    return this.versions.get(assetId)?.at(-1);
  }

  summaries(filter: PrefabFilter = {}): PrefabSummary[] {
    const text = filter.text?.trim().toLowerCase();
    return this.all()
      .map((stored) => {
        const contentHash = computeContentHash(stored.document);
        const report = this.validate({
          assetType: 'game-object-prefab',
          assetId: stored.id,
          version: stored.version,
          contentHash,
        });
        return {
          id: stored.id,
          version: stored.version,
          contentHash,
          displayName: stored.document.metadata.displayName,
          description: stored.document.metadata.description,
          tags: stored.document.metadata.tags,
          derivation: stored.document.derivation.mode,
          abstract: stored.document.abstract,
          componentTypes: componentTypesOf(stored.document),
          protectionLevel: stored.document.metadata.protection?.level ?? 'editable',
          searchTerms: searchTermsOf(stored.document),
          valid: report.valid,
          issueCodes: [...new Set(report.issues.map((issue) => issue.code))],
        } satisfies PrefabSummary;
      })
      .filter((summary) => {
        if (filter.tag && !summary.tags.includes(filter.tag)) return false;
        if (filter.derivation && summary.derivation !== filter.derivation) return false;
        if (filter.onlyPlaceable && summary.abstract) return false;
        if (filter.onlyInvalid && summary.valid) return false;
        if (text) {
          const haystack = summary.searchTerms.join(' ').toLowerCase();
          if (!haystack.includes(text)) return false;
        }
        return true;
      });
  }
}

/** Every Prefab dependency of one asset, animation and Prefab alike. */
export function directDependencies(asset: GameObjectPrefabAsset): RepositoryAssetReference[] {
  const out: RepositoryAssetReference[] = [];
  if (asset.derivation.mode === 'variant') out.push(asset.derivation.parent);
  if (asset.derivation.mode === 'fork') out.push(asset.derivation.forkedFrom);
  if (prefabHasStoredRoot(asset)) {
    for (const node of walkStoredNodes(asset.root)) {
      for (const component of node.components) {
        if (component.componentType !== 'animator') continue;
        out.push(component.assignment.behavior);
        out.push(component.assignment.motionSet);
        out.push(component.assignment.rig);
        if (component.assignment.tuning) out.push(component.assignment.tuning);
      }
    }
    out.push(...nestedPrefabReferences(asset.root));
  }
  return out;
}
