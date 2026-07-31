/**
 * Variants, forks and duplicates (PLAN 22, 23).
 *
 * The three exist because "I want to change this shared thing" has three
 * genuinely different answers, and picking one silently is how a shared asset
 * quietly stops being shared:
 *
 *   variant   — stays attached to the parent, stores only the difference.
 *   fork      — takes a snapshot and cuts the link. Parent may be deleted.
 *   duplicate — a new base asset that merely happens to start here.
 */
import type {
  AnimationBehaviorAsset,
  AnimationGraphDefinition,
  AssetIssue,
  AssetReference,
  CanonicalPatch,
  ProtectionLevel,
  ProtectionMetadata,
  ResolvedValue,
} from '@atc/schema';
import { NEW_ASSET_VERSION, referenceKey } from '@atc/schema';
import { flattenValues, getAtPath } from '@atc/runtime-core';
import { applyPatches } from './patch.ts';
import { sealAsset } from './hashing.ts';
import type { AnimationAssetRegistry } from './registry.ts';

export interface ResolvedBehavior {
  asset: AnimationBehaviorAsset;
  graph: AnimationGraphDefinition;
  /** Chain from the base asset to the requested one, base first. */
  lineage: AssetReference[];
  resolved: ResolvedValue[];
  issues: AssetIssue[];
}

const PROTECTION_RANK: Record<ProtectionLevel, number> = {
  editable: 0,
  'approval-required': 1,
  locked: 2,
  invariant: 3,
};

/**
 * Protection may be tightened by a derived asset, never loosened. Without this
 * a variant would be a trivial way to launder a locked value into an editable
 * one, and the whole protection mechanism would be advisory.
 */
export function protectionWeakenings(
  parent: unknown,
  child: unknown,
): { path: string; from: ProtectionLevel; to: ProtectionLevel }[] {
  const findings: { path: string; from: ProtectionLevel; to: ProtectionLevel }[] = [];
  for (const [path, value] of flattenValues(parent)) {
    if (!path.endsWith('/protection/level')) continue;
    const before = value as ProtectionLevel;
    const after = getAtPath(child, path) as ProtectionLevel | undefined;
    // A removed protection block is the strongest possible weakening.
    const effective: ProtectionLevel = after ?? 'editable';
    if (PROTECTION_RANK[effective] < PROTECTION_RANK[before]) {
      findings.push({ path, from: before, to: effective });
    }
  }
  return findings;
}

/**
 * Resolves a behaviour to a concrete graph, walking up the variant chain.
 *
 * `seen` carries the references already on the stack. A variant whose ancestry
 * loops back on itself is refused rather than recursed into, because the
 * alternative is a stack overflow at project-load time with no useful message.
 */
export function resolveBehaviorAsset(
  registry: AnimationAssetRegistry,
  reference: AssetReference,
  seen: string[] = [],
): ResolvedBehavior {
  const key = referenceKey(reference);
  if (seen.includes(key)) {
    return {
      asset: {} as AnimationBehaviorAsset,
      graph: { schemaVersion: 2, id: 'unresolved', layers: [], states: [], transitions: [], forcedTransitionOrder: [] },
      lineage: [],
      resolved: [],
      issues: [
        {
          code: 'circular-variant',
          severity: 'error',
          message: `variant chain loops: ${[...seen, key].join(' -> ')}`,
          reference,
        },
      ],
    };
  }

  const referenceIssues = registry.checkReference(reference);
  if (referenceIssues.length > 0) {
    return {
      asset: {} as AnimationBehaviorAsset,
      graph: { schemaVersion: 2, id: 'unresolved', layers: [], states: [], transitions: [], forcedTransitionOrder: [] },
      lineage: [],
      resolved: [],
      issues: referenceIssues,
    };
  }

  const asset = registry.getBehavior(reference);

  if (asset.derivation.mode !== 'variant') {
    // Base and fork both carry their own graph. A fork reads no parent at all,
    // which is exactly the property that lets the parent be deleted.
    if (!asset.graph) {
      return {
        asset,
        graph: { schemaVersion: 2, id: asset.metadata.id, layers: [], states: [], transitions: [], forcedTransitionOrder: [] },
        lineage: [reference],
        resolved: [],
        issues: [
          {
            code: 'schema-invalid',
            severity: 'error',
            message: `${asset.metadata.id} is a ${asset.derivation.mode} behaviour but has no graph`,
            reference,
          },
        ],
      };
    }
    return {
      asset,
      graph: asset.graph,
      lineage: [reference],
      resolved: [],
      issues: [],
    };
  }

  const parent = resolveBehaviorAsset(registry, asset.derivation.parent, [...seen, key]);
  if (parent.issues.some((issue) => issue.severity === 'error')) {
    return { ...parent, lineage: [...parent.lineage, reference] };
  }

  const issues: AssetIssue[] = [...parent.issues];
  const application = applyPatches(parent.graph, asset.derivation.patches, {
    source: 'behavior-variant',
    sourceAsset: reference,
    requireExistingPath: false,
  });
  for (const rejection of application.rejected) {
    issues.push({
      code: 'invalid-patch-path',
      severity: 'error',
      message: `patch ${rejection.patch.op} ${rejection.patch.path}: ${rejection.reason}`,
      path: rejection.patch.path,
      reference,
    });
  }

  const graph = application.document as AnimationGraphDefinition;

  for (const weakening of protectionWeakenings(parent.graph, graph)) {
    issues.push({
      code: 'protection-weakened',
      severity: 'error',
      message: `variant lowers protection at ${weakening.path} from ${weakening.from} to ${weakening.to}`,
      path: weakening.path,
      reference,
    });
  }

  // A required motion slot the parent declares cannot be dropped by a variant.
  const parentRequired = new Set(
    (parent.asset.motionSlots ?? []).filter((slot) => slot.required).map((slot) => slot.id),
  );
  const ownSlots = new Set((asset.motionSlots ?? []).map((slot) => slot.id));
  for (const required of parentRequired) {
    if (asset.motionSlots.length > 0 && !ownSlots.has(required)) {
      issues.push({
        code: 'missing-required-motion-slot',
        severity: 'error',
        message: `variant drops required motion slot "${required}" declared by its parent`,
        reference,
      });
    }
  }

  return {
    asset: {
      ...asset,
      // The resolved graph and slot contract are derived, never stored back.
      graph,
      motionSlots: asset.motionSlots.length > 0 ? asset.motionSlots : parent.asset.motionSlots,
      parameters: asset.parameters.length > 0 ? asset.parameters : parent.asset.parameters,
      semanticEvents:
        asset.semanticEvents.length > 0 ? asset.semanticEvents : parent.asset.semanticEvents,
    },
    graph,
    lineage: [...parent.lineage, reference],
    resolved: [...parent.resolved, ...application.resolved],
    issues,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface DerivationRequest {
  newAssetId: string;
  displayName: string;
  description?: string;
  createdBy: string;
  tags?: string[];
  /** ISO timestamp. Passed in so migrations and tests stay deterministic. */
  createdAt?: string;
}

/** A variant: the parent reference plus the patches, and nothing else. */
export function createBehaviorVariant(
  registry: AnimationAssetRegistry,
  parentReference: AssetReference,
  patches: CanonicalPatch[],
  request: DerivationRequest,
): AnimationBehaviorAsset {
  const parent = registry.getBehavior(parentReference);
  return sealAsset<AnimationBehaviorAsset>({
    metadata: {
      schemaVersion: 2,
      assetType: 'animation-behavior',
      id: request.newAssetId,
      version: NEW_ASSET_VERSION,
      displayName: request.displayName,
      description: request.description ?? `Variant of ${parent.metadata.displayName}`,
      tags: request.tags ?? [...parent.metadata.tags, 'variant'],
      createdAt: request.createdAt ?? nowIso(),
      createdBy: request.createdBy,
      contentHash: '',
      ...(parent.metadata.protection ? { protection: parent.metadata.protection } : {}),
    },
    derivation: { mode: 'variant', parent: parentReference, patches },
    parameters: [],
    motionSlots: parent.motionSlots,
    semanticEvents: [],
    replayFixtureIds: parent.replayFixtureIds,
  });
}

/**
 * A fork: the parent resolved to a flat snapshot, then detached. Everything the
 * parent contributed is now this asset's own, so nothing reads the parent again.
 */
export function createBehaviorFork(
  registry: AnimationAssetRegistry,
  parentReference: AssetReference,
  forkIntent: string,
  request: DerivationRequest,
): { asset: AnimationBehaviorAsset; issues: AssetIssue[] } {
  const resolved = resolveBehaviorAsset(registry, parentReference);
  const parent = registry.getBehavior(parentReference);
  const asset = sealAsset<AnimationBehaviorAsset>({
    metadata: {
      schemaVersion: 2,
      assetType: 'animation-behavior',
      id: request.newAssetId,
      version: NEW_ASSET_VERSION,
      displayName: request.displayName,
      description: request.description ?? `Fork of ${parent.metadata.displayName}`,
      tags: request.tags ?? [...parent.metadata.tags, 'fork'],
      createdAt: request.createdAt ?? nowIso(),
      createdBy: request.createdBy,
      contentHash: '',
      assetProvenance: { forkedFrom: parentReference, note: forkIntent },
      ...(parent.metadata.protection ? { protection: parent.metadata.protection } : {}),
    },
    derivation: { mode: 'fork', forkedFrom: parentReference, forkIntent },
    parameters: resolved.asset.parameters ?? [],
    motionSlots: resolved.asset.motionSlots ?? [],
    semanticEvents: resolved.asset.semanticEvents ?? [],
    graph: { ...resolved.graph, id: request.newAssetId },
    replayFixtureIds: parent.replayFixtureIds,
  });
  return { asset, issues: resolved.issues };
}

/**
 * A duplicate. Same snapshot mechanics as a fork; the difference is intent, and
 * intent is recorded rather than inferred — `duplicatedFrom` says "this started
 * as a copy", where `forkedFrom` says "compare me against my origin".
 */
export function duplicateBehavior(
  registry: AnimationAssetRegistry,
  sourceReference: AssetReference,
  request: DerivationRequest,
): { asset: AnimationBehaviorAsset; issues: AssetIssue[] } {
  const resolved = resolveBehaviorAsset(registry, sourceReference);
  const source = registry.getBehavior(sourceReference);
  const asset = sealAsset<AnimationBehaviorAsset>({
    metadata: {
      schemaVersion: 2,
      assetType: 'animation-behavior',
      id: request.newAssetId,
      version: NEW_ASSET_VERSION,
      displayName: request.displayName,
      description: request.description ?? `Copy of ${source.metadata.displayName}`,
      tags: request.tags ?? [...source.metadata.tags],
      createdAt: request.createdAt ?? nowIso(),
      createdBy: request.createdBy,
      contentHash: '',
      assetProvenance: { duplicatedFrom: sourceReference },
    },
    derivation: { mode: 'base' },
    parameters: resolved.asset.parameters ?? [],
    motionSlots: resolved.asset.motionSlots ?? [],
    semanticEvents: resolved.asset.semanticEvents ?? [],
    graph: { ...resolved.graph, id: request.newAssetId },
    replayFixtureIds: [],
  });
  return { asset, issues: resolved.issues };
}

export function protectionOf(value: unknown): ProtectionMetadata | undefined {
  if (value && typeof value === 'object' && 'protection' in (value as object)) {
    return (value as { protection?: ProtectionMetadata }).protection;
  }
  return undefined;
}
