/**
 * Who owns a staged change.
 *
 * The animation workspace edits one flat document, but that document is a
 * *join*: its graph came from a Behavior asset, its clips from Clip assets, its
 * bindings from a Motion Set, its tuning from a tuning profile or the project,
 * and its presentation from a Prefab Component. Saving it is therefore not one
 * write — it is several, to several owners, with different blast radii.
 *
 * The legacy path did not have this problem because it did not ask the
 * question: `commit()` wrote project.json and called it done. That is exactly
 * what §7 forbids. A staged path whose owner cannot be named is *blocking*
 * here, because the alternative — guessing a destination from the shape of the
 * path — is how a graph edit ends up written into a tuning profile that happens
 * to have a similarly-named field.
 *
 * This module is pure. It classifies; it plans nothing and writes nothing.
 */
import type { AssetReference, AnimationSubjectDefinition } from '@atc/schema';
import type { CanonicalPath } from '@atc/runtime-core';
import type { AnimationChamberDocument } from './AnimationChamberDocument.ts';

export type AnimationPublicationDomainId =
  | 'behavior'
  | 'motion-set'
  | 'clip'
  | 'tuning'
  | 'project-tuning'
  | 'prefab-presentation'
  | 'unowned';

/** The exact thing a staged change would be written into. */
export type AnimationPublicationOwner =
  | { kind: 'animation-asset'; reference: AssetReference }
  | {
      kind: 'prefab-component';
      prefab: AnimationSubjectDefinition['source']['prefab'];
      nodeId: string;
      componentId: string;
    }
  | { kind: 'project'; revisionId: string }
  | { kind: 'none' };

export interface StagedPathOwnership {
  path: CanonicalPath;
  domain: AnimationPublicationDomainId;
  owner: AnimationPublicationOwner;
  /**
   * Present exactly when this path cannot be published. A staged change with a
   * reason is a blocking finding, never a silently dropped write.
   */
  blockedReason?: string;
}

export interface AnimationPublicationDomainSummary {
  domain: AnimationPublicationDomainId;
  label: string;
  owner: AnimationPublicationOwner;
  paths: CanonicalPath[];
  blockedReason?: string;
}

const DOMAIN_LABEL: Record<AnimationPublicationDomainId, string> = {
  behavior: 'Behavior graph asset',
  'motion-set': 'Motion Set asset',
  clip: 'Animation Clip asset',
  tuning: 'Tuning profile asset',
  'project-tuning': 'Project-level tuning',
  'prefab-presentation': 'Prefab presentation Component',
  unowned: 'No exact owner',
};

/** The document fields that are repository tuning rather than asset payload. */
const TUNING_ROOTS = [
  'movement',
  'rootMotion',
  'terrain',
  'camera',
  'inputMap',
  'haptics',
  'equipment',
  'preferences',
  'defaultTerrainPresetId',
] as const;

/**
 * Fields the document carries for the panels' benefit and nobody authors.
 *
 * They are derived — resolution provenance, the resolved context keys, the
 * subject's own identity — so a staged change to one is not a save that needs a
 * destination, it is a bug that needs saying out loud.
 */
const DERIVED_ROOTS = [
  'subject',
  'resolution',
  'motionContextKeys',
  'clipAssetSources',
  'rigCompatibilityKey',
  'skeleton',
  'replays',
  'revisionId',
] as const;

function firstSegment(path: CanonicalPath): string {
  return path.split('/')[1] ?? '';
}

/**
 * Which clip a `/clips/<index>/…` path belongs to.
 *
 * The document flattens the resolved clips into an array, and the array index
 * is not an identity — a Motion Set that binds a different clip renumbers it.
 * So the index is resolved back to a clip id and then to the exact asset
 * reference the resolver recorded, and an index that resolves to neither is
 * blocking rather than assigned to whichever clip is nearby.
 */
function clipOwner(
  path: CanonicalPath,
  document: AnimationChamberDocument,
): { reference?: AssetReference; clipId?: string } {
  const index = Number(path.split('/')[2]);
  const clip = Number.isInteger(index) ? document.clips[index] : undefined;
  if (!clip) return {};
  return { clipId: clip.id, reference: document.clipAssetSources[clip.id] };
}

export function classifyStagedPath(
  path: CanonicalPath,
  document: AnimationChamberDocument,
): StagedPathOwnership {
  const root = firstSegment(path);
  const assignment = document.subject.animator.assignment;

  if (root === 'graph') {
    return {
      path,
      domain: 'behavior',
      owner: { kind: 'animation-asset', reference: assignment.behavior },
    };
  }

  if (root === 'motionBindings' || root === 'contextualMotionBindings') {
    return {
      path,
      domain: 'motion-set',
      owner: { kind: 'animation-asset', reference: assignment.motionSet },
    };
  }

  if (root === 'clips') {
    const { reference, clipId } = clipOwner(path, document);
    if (!reference) {
      return {
        path,
        domain: 'unowned',
        owner: { kind: 'none' },
        blockedReason:
          clipId === undefined
            ? `${path} names no clip in this subject's resolved set, so there is no asset to publish it into.`
            : `clip "${clipId}" has no recorded source asset, so the change has no exact destination.`,
      };
    }
    return { path, domain: 'clip', owner: { kind: 'animation-asset', reference } };
  }

  if (root === 'presentation') {
    return {
      path,
      domain: 'prefab-presentation',
      owner: {
        kind: 'prefab-component',
        prefab: document.subject.source.prefab,
        nodeId: document.subject.source.nodeId,
        componentId: document.subject.source.componentId,
      },
    };
  }

  if ((TUNING_ROOTS as readonly string[]).includes(root)) {
    /*
     * A tuning profile owns these when the Animator names one. When it does
     * not, the values genuinely are project-level in the canonical schema —
     * which is the one case where "project-owned" is an answer rather than a
     * fallback.
     */
    if (assignment.tuning) {
      return {
        path,
        domain: 'tuning',
        owner: { kind: 'animation-asset', reference: assignment.tuning },
      };
    }
    return { path, domain: 'project-tuning', owner: { kind: 'project', revisionId: document.revisionId } };
  }

  if ((DERIVED_ROOTS as readonly string[]).includes(root)) {
    return {
      path,
      domain: 'unowned',
      owner: { kind: 'none' },
      blockedReason: `${path} is resolved state, not authored state. Nothing owns it, so it cannot be published.`,
    };
  }

  return {
    path,
    domain: 'unowned',
    owner: { kind: 'none' },
    blockedReason: `${path} has no exact owning domain. Publication refuses rather than guessing a destination.`,
  };
}

/** One row per owning domain, in a stable order, for the Save Destination surface. */
export function summarizeStagedDomains(
  stagedPaths: readonly CanonicalPath[],
  document: AnimationChamberDocument,
): AnimationPublicationDomainSummary[] {
  const byKey = new Map<string, AnimationPublicationDomainSummary>();
  for (const path of stagedPaths) {
    const ownership = classifyStagedPath(path, document);
    const key = `${ownership.domain}:${ownerKey(ownership.owner)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.paths.push(path);
      continue;
    }
    byKey.set(key, {
      domain: ownership.domain,
      label: DOMAIN_LABEL[ownership.domain],
      owner: ownership.owner,
      paths: [path],
      ...(ownership.blockedReason ? { blockedReason: ownership.blockedReason } : {}),
    });
  }
  const order: AnimationPublicationDomainId[] = [
    'behavior',
    'motion-set',
    'clip',
    'tuning',
    'project-tuning',
    'prefab-presentation',
    'unowned',
  ];
  return [...byKey.values()].sort(
    (a, b) => order.indexOf(a.domain) - order.indexOf(b.domain) || ownerKey(a.owner).localeCompare(ownerKey(b.owner)),
  );
}

export function ownerKey(owner: AnimationPublicationOwner): string {
  switch (owner.kind) {
    case 'animation-asset':
      return `${owner.reference.assetType}:${owner.reference.assetId}@${owner.reference.version}`;
    case 'prefab-component':
      return `prefab:${owner.prefab.assetId}@${owner.prefab.version}/${owner.nodeId}/${owner.componentId}`;
    case 'project':
      return `project@${owner.revisionId}`;
    case 'none':
      return 'none';
  }
}

/** Human-readable, and exact: never "this character", never "all holders". */
export function describeOwner(owner: AnimationPublicationOwner): string {
  switch (owner.kind) {
    case 'animation-asset':
      return `${owner.reference.assetId}@${owner.reference.version} (${owner.reference.assetType})`;
    case 'prefab-component':
      return (
        `${owner.prefab.assetId}@${owner.prefab.version} ` +
        `node ${owner.nodeId}, Component ${owner.componentId}`
      );
    case 'project':
      return `project revision ${owner.revisionId}`;
    case 'none':
      return 'nothing';
  }
}

/** Every staged path that cannot be published, with the reason. */
export function blockingFindings(
  stagedPaths: readonly CanonicalPath[],
  document: AnimationChamberDocument,
): StagedPathOwnership[] {
  return stagedPaths
    .map((path) => classifyStagedPath(path, document))
    .filter((ownership) => ownership.blockedReason !== undefined);
}
