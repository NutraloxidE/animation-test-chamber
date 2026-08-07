/**
 * The typed drag payload.
 *
 * Carried on a private MIME type rather than as `text/plain`, and parsed back
 * through a validator rather than trusted. Every alternative the work package
 * forbids (§12.2) fails in the same way: DOM text, a list index, a React
 * component identity or a bare URL all *look* like an asset reference at the
 * drop site and none of them can be checked, so the first malformed drop
 * becomes a malformed instance in a canonical file.
 *
 * What it now carries is one thing: an **exact Prefab reference** — id, version
 * and content hash. It used to carry a four-branch `PlaceableAsset` kind, and
 * losing that is the point of the Scene cutover: "place a Light" and "place a
 * Character" are the same action naming different Prefabs, not different actions
 * producing different kinds of thing.
 *
 * The version and hash travel *with* the drag rather than being looked up at the
 * drop site (§8.2). A drop that resolved "latest" would place whatever had been
 * published between the mousedown and the mouseup.
 *
 * The payload still deliberately carries no transform. Where a thing lands is
 * decided by the drop, not by the drag.
 */
import type { GameObjectPrefabReference } from '@atc/schema';

/** Private to this app; a browser will not hand it to another page by accident. */
export const SCENE_ASSET_MIME = 'application/x-atc-scene-asset';

export interface ScenePrefabDragPayload {
  kind: 'prefab';
  prefab: GameObjectPrefabReference;
  /** Display name to give the placed GameObject. */
  displayName: string;
}

export function writeDragPayload(
  transfer: DataTransfer,
  payload: ScenePrefabDragPayload,
): void {
  transfer.setData(SCENE_ASSET_MIME, JSON.stringify(payload));
  transfer.effectAllowed = 'copy';
}

/**
 * The payload a drop carries, or `null`.
 *
 * `null` for anything unrecognised — a file dragged in from the desktop, a
 * selection from another tab, a payload from an older build that still speaks
 * `{ kind: 'character' }`. Refusing is the whole job: OS file import has to go
 * through the acquisition pipeline so provenance and licence checks happen, and
 * a drop handler that turned an arbitrary file into a Scene GameObject would be
 * a way around them (§12.8).
 */
export function readDragPayload(transfer: DataTransfer): ScenePrefabDragPayload | null {
  const raw = transfer.getData(SCENE_ASSET_MIME);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const candidate = parsed as Partial<ScenePrefabDragPayload>;
  if (candidate.kind !== 'prefab') return null;
  if (typeof candidate.displayName !== 'string') return null;

  const prefab = candidate.prefab as Partial<GameObjectPrefabReference> | undefined;
  if (
    prefab?.assetType !== 'game-object-prefab' ||
    typeof prefab.assetId !== 'string' ||
    typeof prefab.version !== 'string' ||
    typeof prefab.contentHash !== 'string'
  ) {
    // A reference missing its version or hash is refused rather than completed
    // here. Filling one in would be this file resolving "latest", which is the
    // one thing an exact reference exists to stop.
    return null;
  }

  return {
    kind: 'prefab',
    displayName: candidate.displayName,
    prefab: {
      assetType: 'game-object-prefab',
      assetId: prefab.assetId,
      version: prefab.version,
      contentHash: prefab.contentHash,
    },
  };
}

/**
 * A collision-free GameObject id derived from the dragged Prefab.
 *
 * A stable counter, not a random suffix: a fixture asserting on the id of a
 * dropped object could not be written against `crate-7f3a`, and two runs of the
 * same interaction test would produce documents that diff against each other.
 */
export function placementGameObjectId(
  base: string,
  existing: readonly { id: string }[],
): string {
  const taken = new Set(existing.map((entry) => entry.id));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}
