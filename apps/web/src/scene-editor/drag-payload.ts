/**
 * The typed drag payload.
 *
 * Carried on a private MIME type rather than as `text/plain`, and parsed back
 * through a validator rather than trusted. Every alternative the work package
 * forbids (§12.2) fails in the same way: DOM text, a list index, a React
 * component identity or a bare URL all *look* like an asset reference at the
 * drop site and none of them can be checked, so the first malformed drop
 * becomes a malformed entity in a canonical file.
 *
 * The payload also deliberately carries no transform. Where a thing lands is
 * decided by the drop, not by the drag.
 */
import type { PlaceableAsset } from '@atc/editor-core';

/** Private to this app; a browser will not hand it to another page by accident. */
export const SCENE_ASSET_MIME = 'application/x-atc-scene-asset';

export interface SceneAssetDragPayload {
  kind: PlaceableAsset['kind'];
  /** Character id, asset id, or the light type for a creation entry. */
  id: string;
  /** Display name to give the placed entity. */
  displayName: string;
  version?: string;
}

export function writeDragPayload(
  transfer: DataTransfer,
  payload: SceneAssetDragPayload,
): void {
  transfer.setData(SCENE_ASSET_MIME, JSON.stringify(payload));
  transfer.effectAllowed = 'copy';
}

/**
 * The payload a drop carries, or `null`.
 *
 * `null` for anything unrecognised — a file dragged in from the desktop, a
 * selection from another tab, a payload from an older build. Refusing is the
 * whole job: OS file import has to go through the acquisition pipeline so
 * provenance and licence checks happen, and a drop handler that turned an
 * arbitrary file into a Scene entity would be a way around them (§12.8).
 */
export function readDragPayload(transfer: DataTransfer): SceneAssetDragPayload | null {
  const raw = transfer.getData(SCENE_ASSET_MIME);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const candidate = parsed as Partial<SceneAssetDragPayload>;
  const kinds: PlaceableAsset['kind'][] = ['character', 'prop', 'light', 'camera'];
  if (typeof candidate.kind !== 'string' || !kinds.includes(candidate.kind as PlaceableAsset['kind'])) {
    return null;
  }
  if (typeof candidate.id !== 'string' || typeof candidate.displayName !== 'string') return null;

  return {
    kind: candidate.kind as PlaceableAsset['kind'],
    id: candidate.id,
    displayName: candidate.displayName,
    ...(typeof candidate.version === 'string' ? { version: candidate.version } : {}),
  };
}

/** The `PlaceableAsset` a payload names, for `scene.place_asset`. */
export function assetOf(payload: SceneAssetDragPayload): PlaceableAsset | null {
  switch (payload.kind) {
    case 'character':
      return { kind: 'character', characterId: payload.id };
    case 'camera':
      return { kind: 'camera' };
    case 'light': {
      const types = ['directional', 'point', 'spot'] as const;
      const lightType = types.find((entry) => entry === payload.id);
      return lightType ? { kind: 'light', lightType } : null;
    }
    case 'prop':
      return { kind: 'prop', asset: { kind: 'model', assetPath: payload.id } };
  }
}

/**
 * A collision-free entity id derived from the dragged asset.
 *
 * A stable counter, not a random suffix: a fixture asserting on the id of a
 * dropped entity could not be written against `crate-7f3a`, and two runs of the
 * same interaction test would produce documents that diff against each other.
 */
export function placementEntityId(
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
