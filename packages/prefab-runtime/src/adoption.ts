/**
 * Planning an adoption (§14.3, §14.5).
 *
 * The whole point is one equality:
 *
 *   displayed target ids === request target ids === changed target ids
 *
 * A confirmation dialog that renders from a separately computed prose string can
 * say "this affects all three characters" while the request re-points one. So
 * the plan is computed *from the request object that will be sent*, and the same
 * plan is what the server validates and what the transaction applies. The three
 * lists are then equal by construction rather than by review.
 *
 * This module is pure. It reads a usage graph and a request and returns what
 * would change; it writes nothing. The transaction that applies it is the
 * existing repository transaction — see the audit report for what is still
 * outstanding on the HTTP side.
 */
import type {
  AssetReference,
  GameObjectPrefabReference,
  PublishAnimationAndUpdatePrefabsRequest,
  PublishPrefabAndUpdateInstancesRequest,
  SceneInstanceReference,
} from '@atc/schema';
import { referenceKey } from '@atc/schema';
import type { PrefabUsageDescription } from './usage.ts';
import { prefabHoldersOfAnimationAsset } from './usage.ts';

export interface AdoptionConflict {
  code: 'unknown-target' | 'target-does-not-hold-source' | 'stale-holder-snapshot';
  message: string;
}

export interface AdoptionPlan<TTarget> {
  /** Exactly what the request asked to change, and what a transaction would touch. */
  targets: TTarget[];
  /** Everything that holds the source and was deliberately *not* named. */
  untouched: TTarget[];
  /** Non-empty means refuse: 409, no writes (§14.3). */
  conflicts: AdoptionConflict[];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sorted = (values: readonly string[]) => [...values].sort();
  return sorted(left).every((value, index) => value === sorted(right)[index]);
}

/**
 * Which Prefabs adopt a newly published animation asset version.
 *
 * The stale-snapshot check compares the holder list the client *believed* with
 * the one the repository has now. It is not a courtesy: the human approved a
 * blast radius drawn from that snapshot, and if a sixth Prefab started holding
 * the Behavior in between, silently including or excluding it are both wrong
 * answers to a question only the human can settle.
 */
export function planAnimationAdoption(input: {
  usage: readonly PrefabUsageDescription[];
  request: PublishAnimationAndUpdatePrefabsRequest;
  currentProjectRevisionId: string;
}): AdoptionPlan<GameObjectPrefabReference> {
  const { usage, request } = input;
  const conflicts: AdoptionConflict[] = [];

  if (request.expected.sourceContentHash !== request.source.contentHash) {
    conflicts.push({
      code: 'stale-holder-snapshot',
      message: `the request's expected source hash does not match the source it names`,
    });
  }
  if (request.expected.projectRevisionId !== input.currentProjectRevisionId) {
    conflicts.push({
      code: 'stale-holder-snapshot',
      message:
        `the project moved from revision "${request.expected.projectRevisionId}" to ` +
        `"${input.currentProjectRevisionId}" since the targets were chosen`,
    });
  }

  const holders = prefabHoldersOfAnimationAsset(usage, request.source as AssetReference);
  const believed = request.expected.prefabReferences.map(
    (reference) => `${reference.assetId}@${reference.version}`,
  );
  const actual = holders.map((reference) => `${reference.assetId}@${reference.version}`);
  if (!sameSet(believed, actual)) {
    conflicts.push({
      code: 'stale-holder-snapshot',
      message:
        `${referenceKey(request.source)} is held by [${actual.join(', ') || 'nothing'}], ` +
        `not by [${believed.join(', ') || 'nothing'}] as the request expects`,
    });
  }

  const targets: GameObjectPrefabReference[] = [];
  const untouched: GameObjectPrefabReference[] = [];
  const named = new Set(request.targetPrefabIds);
  for (const holder of holders) {
    if (named.has(holder.assetId)) targets.push(holder);
    else untouched.push(holder);
  }
  for (const id of request.targetPrefabIds) {
    if (!holders.some((holder) => holder.assetId === id)) {
      conflicts.push({
        code: holders.length === 0 ? 'unknown-target' : 'target-does-not-hold-source',
        message: `Prefab "${id}" does not currently hold ${referenceKey(request.source)}`,
      });
    }
  }

  return { targets, untouched, conflicts };
}

/** Which Scene instances adopt a newly published Prefab version. */
export function planPrefabAdoption(input: {
  usage: readonly PrefabUsageDescription[];
  request: PublishPrefabAndUpdateInstancesRequest;
  currentProjectRevisionId: string;
}): AdoptionPlan<SceneInstanceReference> {
  const { usage, request } = input;
  const conflicts: AdoptionConflict[] = [];

  if (request.expected.sourceContentHash !== request.source.contentHash) {
    conflicts.push({
      code: 'stale-holder-snapshot',
      message: `the request's expected source hash does not match the Prefab it names`,
    });
  }
  if (request.expected.projectRevisionId !== input.currentProjectRevisionId) {
    conflicts.push({
      code: 'stale-holder-snapshot',
      message:
        `the project moved from revision "${request.expected.projectRevisionId}" to ` +
        `"${input.currentProjectRevisionId}" since the targets were chosen`,
    });
  }

  const entry = usage.find(
    (candidate) =>
      candidate.prefab.assetId === request.source.assetId &&
      candidate.prefab.version === request.source.version,
  );
  const holders: SceneInstanceReference[] = (entry?.sceneInstances ?? []).map((use) => ({
    sceneId: use.sceneId,
    gameObjectId: use.gameObjectId,
    prefab: use.prefab,
  }));

  const key = (use: { sceneId: string; gameObjectId: string }): string =>
    `${use.sceneId}/${use.gameObjectId}`;
  if (!sameSet(request.expected.sceneInstanceReferences.map(key), holders.map(key))) {
    conflicts.push({
      code: 'stale-holder-snapshot',
      message:
        `${request.source.assetId}@${request.source.version} is placed at ` +
        `[${holders.map(key).join(', ') || 'nothing'}], not at ` +
        `[${request.expected.sceneInstanceReferences.map(key).join(', ') || 'nothing'}]`,
    });
  }

  const named = new Set(request.targets.map(key));
  const targets = holders.filter((holder) => named.has(key(holder)));
  const untouched = holders.filter((holder) => !named.has(key(holder)));
  for (const target of request.targets) {
    if (!holders.some((holder) => key(holder) === key(target))) {
      conflicts.push({
        code: 'unknown-target',
        message: `no GameObject "${target.gameObjectId}" in scene "${target.sceneId}" holds ${request.source.assetId}@${request.source.version}`,
      });
    }
  }

  return { targets, untouched, conflicts };
}
