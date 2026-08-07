/**
 * The drag payload validator.
 *
 * Every assertion here is about refusing something. A drop handler that trusted
 * what it was handed would turn the first malformed drag — an OS file, a
 * selection from another tab, a payload from an older build — into a malformed
 * GameObject in a canonical file, and the refusal has to happen before the typed
 * operation, not inside it.
 *
 * Since the Scene cutover the payload carries an *exact Prefab reference*, and
 * several of the refusals below are new because of it: a reference missing its
 * version or its content hash is refused rather than completed, because
 * completing one would mean the drop site resolving "latest".
 */
import { describe, expect, it } from 'vitest';
import type { GameObjectPrefabReference } from '@atc/schema';
import {
  SCENE_ASSET_MIME,
  placementGameObjectId,
  readDragPayload,
  writeDragPayload,
  type ScenePrefabDragPayload,
} from '../../../apps/web/src/scene-editor/drag-payload.ts';

const REFERENCE: GameObjectPrefabReference = {
  assetType: 'game-object-prefab',
  assetId: 'navigator',
  version: '1.0.0',
  contentHash: 'e5ea5de669c36f6bbdbbe86e07d9bd092bc53ef44cf48a4272b68c6d1db4c3f7',
};

/** The parts of DataTransfer this module uses, without needing a DOM. */
function transfer(entries: Record<string, string> = {}): DataTransfer {
  const store = new Map(Object.entries(entries));
  return {
    getData: (type: string) => store.get(type) ?? '',
    setData: (type: string, value: string) => void store.set(type, value),
    types: [...store.keys()],
    effectAllowed: 'none',
  } as unknown as DataTransfer;
}

describe('payload round trip', () => {
  it('writes and reads an exact Prefab reference on a private MIME type', () => {
    const payload: ScenePrefabDragPayload = {
      kind: 'prefab',
      prefab: REFERENCE,
      displayName: 'Navigator',
    };
    const data = transfer();
    writeDragPayload(data, payload);
    expect(data.getData(SCENE_ASSET_MIME)).toContain('navigator');
    expect(readDragPayload(data)).toEqual(payload);
  });

  it('carries the version and the content hash, so the drop resolves nothing', () => {
    const data = transfer();
    writeDragPayload(data, { kind: 'prefab', prefab: REFERENCE, displayName: 'Navigator' });
    expect(readDragPayload(data)?.prefab.version).toBe('1.0.0');
    expect(readDragPayload(data)?.prefab.contentHash).toBe(REFERENCE.contentHash);
  });
});

describe('refusals', () => {
  /*
   * Plain text is what a drag from anywhere else looks like. Accepting it is
   * how a selection from another page becomes a Scene GameObject.
   */
  it('refuses a payload carried as text/plain', () => {
    expect(readDragPayload(transfer({ 'text/plain': 'navigator' }))).toBeNull();
  });

  it('refuses an empty transfer — an OS file drag, for instance', () => {
    expect(readDragPayload(transfer())).toBeNull();
  });

  it('refuses malformed JSON rather than throwing into the drop handler', () => {
    expect(readDragPayload(transfer({ [SCENE_ASSET_MIME]: '{ not json' }))).toBeNull();
  });

  /*
   * The retired entity payload. A build still writing `{ kind: 'character' }`
   * must not have its drop half-understood — the Scene no longer has a
   * character kind to place.
   */
  it('refuses a legacy entity-kind payload', () => {
    const data = transfer({
      [SCENE_ASSET_MIME]: JSON.stringify({
        kind: 'character',
        id: 'demo-humanoid',
        displayName: 'Demo humanoid',
      }),
    });
    expect(readDragPayload(data)).toBeNull();
  });

  it('refuses a reference with no version', () => {
    const { version: _dropped, ...partial } = REFERENCE;
    const data = transfer({
      [SCENE_ASSET_MIME]: JSON.stringify({
        kind: 'prefab',
        prefab: partial,
        displayName: 'Navigator',
      }),
    });
    expect(readDragPayload(data)).toBeNull();
  });

  it('refuses a reference with no content hash', () => {
    const { contentHash: _dropped, ...partial } = REFERENCE;
    const data = transfer({
      [SCENE_ASSET_MIME]: JSON.stringify({
        kind: 'prefab',
        prefab: partial,
        displayName: 'Navigator',
      }),
    });
    expect(readDragPayload(data)).toBeNull();
  });

  it('refuses a payload missing a display name', () => {
    expect(
      readDragPayload(
        transfer({ [SCENE_ASSET_MIME]: JSON.stringify({ kind: 'prefab', prefab: REFERENCE }) }),
      ),
    ).toBeNull();
  });
});

describe('placement ids', () => {
  /*
   * A stable counter, not a random suffix: a test asserting on the id of a
   * dropped GameObject could not be written against `crate-7f3a`, and two runs
   * of the same interaction would produce documents that diff against each
   * other.
   */
  it('is deterministic and collision-free', () => {
    expect(placementGameObjectId('crate', [])).toBe('crate');
    expect(placementGameObjectId('crate', [{ id: 'crate' }])).toBe('crate-2');
    expect(placementGameObjectId('crate', [{ id: 'crate' }, { id: 'crate-2' }])).toBe('crate-3');
    expect(placementGameObjectId('crate', [{ id: 'crate' }])).toBe(
      placementGameObjectId('crate', [{ id: 'crate' }]),
    );
  });
});
