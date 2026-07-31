/**
 * Variants, forks and duplicates (PLAN 22, 23; PLAN Part IV).
 *
 * The three exist because "I want to change this shared thing" has three
 * genuinely different answers, and picking one silently is how a shared asset
 * quietly stops being shared:
 *
 *   variant   — stays attached to the parent, stores only the difference.
 *   fork      — takes a snapshot and cuts the link. Parent may be deleted.
 *   duplicate — a new base asset that merely happens to start here.
 *
 * A variant's stored shape has no payload fields at all (PLAN Part IV §21) —
 * `VariantAnimationBehaviorAsset` is schema-illegal to populate with a graph,
 * motion slots, or anything else the parent already declares. Resolving one
 * applies `derivation.patches` to the *parent's resolved payload as a whole*,
 * not just its graph, so a patch may target `/motionSlots/...`,
 * `/parameters/...`, `/semanticEvents/...`, `/replayFixtureIds/...` or
 * `/defaultTuning/...` exactly as it targets `/graph/...` today. That is the
 * entire mechanism behind "a contract the parent gains later reaches every
 * existing variant automatically": there is no stored copy to go stale.
 */
import type {
  AnimationBehaviorAsset,
  AnimationBehaviorPayload,
  AssetIssue,
  AssetReference,
  BaseAnimationBehaviorAsset,
  CanonicalPatch,
  ForkAnimationBehaviorAsset,
  ProtectionLevel,
  ProtectionMetadata,
  ResolvedAnimationBehaviorAsset,
  ResolvedValue,
  VariantAnimationBehaviorAsset,
} from '@atc/schema';
import { NEW_ASSET_VERSION, referenceKey } from '@atc/schema';
import { flattenValues, getAtPath } from '@atc/runtime-core';
import { applyPatches } from './patch.ts';
import { sealAsset } from './hashing.ts';
import type { AnimationAssetRegistry } from './registry.ts';

export interface ResolvedBehavior {
  asset: ResolvedAnimationBehaviorAsset;
  graph: AnimationBehaviorPayload['graph'];
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

const EMPTY_GRAPH: AnimationBehaviorPayload['graph'] = {
  schemaVersion: 2,
  id: 'unresolved',
  layers: [],
  states: [],
  transitions: [],
  forcedTransitionOrder: [],
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

function unresolved(issues: AssetIssue[]): ResolvedBehavior {
  return {
    asset: {} as ResolvedAnimationBehaviorAsset,
    graph: EMPTY_GRAPH,
    lineage: [],
    resolved: [],
    issues,
  };
}

/**
 * A user-defined type guard rather than a plain `asset.derivation.mode`
 * check: TypeScript narrows a union only on its *own* discriminant property,
 * not on a nested one reached through another property, so checking
 * `asset.derivation.mode` inline would leave `asset` itself unnarrowed.
 */
export function isVariantAsset(asset: AnimationBehaviorAsset): asset is VariantAnimationBehaviorAsset {
  return asset.derivation.mode === 'variant';
}

/** The concrete payload fields off a resolved (or base/fork) behaviour asset. */
function payloadOf(asset: BaseAnimationBehaviorAsset | ForkAnimationBehaviorAsset): AnimationBehaviorPayload {
  return {
    parameters: asset.parameters,
    motionSlots: asset.motionSlots,
    semanticEvents: asset.semanticEvents,
    graph: asset.graph,
    ...(asset.defaultTuning !== undefined ? { defaultTuning: asset.defaultTuning } : {}),
    replayFixtureIds: asset.replayFixtureIds,
  };
}

/**
 * Resolves a behaviour to a concrete payload, walking up the variant chain.
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
    return unresolved([
      {
        code: 'circular-variant',
        severity: 'error',
        message: `variant chain loops: ${[...seen, key].join(' -> ')}`,
        reference,
      },
    ]);
  }

  const referenceIssues = registry.checkReference(reference);
  if (referenceIssues.length > 0) {
    return unresolved(referenceIssues);
  }

  const asset = registry.getBehavior(reference);

  if (!isVariantAsset(asset)) {
    // Base and fork both carry their own full payload. A fork reads no parent
    // at all, which is exactly the property that lets the parent be deleted.
    const payload = payloadOf(asset);
    return {
      asset: { metadata: asset.metadata, derivation: asset.derivation, ...payload },
      graph: payload.graph,
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
  const parentPayload: AnimationBehaviorPayload = {
    parameters: parent.asset.parameters,
    motionSlots: parent.asset.motionSlots,
    semanticEvents: parent.asset.semanticEvents,
    graph: parent.asset.graph,
    ...(parent.asset.defaultTuning !== undefined ? { defaultTuning: parent.asset.defaultTuning } : {}),
    replayFixtureIds: parent.asset.replayFixtureIds,
  };
  const application = applyPatches(parentPayload, asset.derivation.patches, {
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

  const patchedPayload = application.document as AnimationBehaviorPayload;

  for (const weakening of protectionWeakenings(parentPayload, patchedPayload)) {
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
    parentPayload.motionSlots.filter((slot) => slot.required).map((slot) => slot.id),
  );
  const resolvedSlotIds = new Set(patchedPayload.motionSlots.map((slot) => slot.id));
  for (const required of parentRequired) {
    if (!resolvedSlotIds.has(required)) {
      issues.push({
        code: 'missing-required-motion-slot',
        severity: 'error',
        message: `variant drops required motion slot "${required}" declared by its parent`,
        reference,
      });
    }
  }

  return {
    asset: { metadata: asset.metadata, derivation: asset.derivation, ...patchedPayload },
    graph: patchedPayload.graph,
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
): VariantAnimationBehaviorAsset {
  const parent = registry.getBehavior(parentReference);
  return sealAsset<VariantAnimationBehaviorAsset>({
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
): { asset: ForkAnimationBehaviorAsset; issues: AssetIssue[] } {
  const resolved = resolveBehaviorAsset(registry, parentReference);
  const parent = registry.getBehavior(parentReference);
  const asset = sealAsset<ForkAnimationBehaviorAsset>({
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
    replayFixtureIds: resolved.asset.replayFixtureIds ?? [],
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
): { asset: BaseAnimationBehaviorAsset; issues: AssetIssue[] } {
  const resolved = resolveBehaviorAsset(registry, sourceReference);
  const source = registry.getBehavior(sourceReference);
  const asset = sealAsset<BaseAnimationBehaviorAsset>({
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
