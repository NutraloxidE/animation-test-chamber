/**
 * The drag payload validator.
 *
 * Every assertion here is about refusing something. A drop handler that trusted
 * what it was handed would turn the first malformed drag — an OS file, a
 * selection from another tab, a payload from an older build — into a malformed
 * entity in a canonical file, and the refusal has to happen before the typed
 * operation, not inside it.
 */
import { describe, expect, it } from 'vitest';
import {
  SCENE_ASSET_MIME,
  assetOf,
  placementEntityId,
  readDragPayload,
  writeDragPayload,
  type SceneAssetDragPayload,
} from '../../../apps/web/src/scene-editor/drag-payload.ts';

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
  it('writes and reads a character payload on a private MIME type', () => {
    const payload: SceneAssetDragPayload = {
      kind: 'character',
      id: 'demo-humanoid',
      displayName: 'Demo humanoid',
    };
    const data = transfer();
    writeDragPayload(data, payload);
    expect(data.getData(SCENE_ASSET_MIME)).toContain('demo-humanoid');
    expect(readDragPayload(data)).toEqual(payload);
  });
});

describe('refusals', () => {
  /*
   * Plain text is what a drag from anywhere else looks like. Accepting it is
   * how a selection from another page becomes a scene entity.
   */
  it('refuses a payload carried as text/plain', () => {
    expect(readDragPayload(transfer({ 'text/plain': 'demo-humanoid' }))).toBeNull();
  });

  it('refuses an empty transfer — an OS file drag, for instance', () => {
    expect(readDragPayload(transfer())).toBeNull();
  });

  it('refuses malformed JSON rather than throwing into the drop handler', () => {
    expect(readDragPayload(transfer({ [SCENE_ASSET_MIME]: '{ not json' }))).toBeNull();
  });

  it('refuses an unknown asset kind', () => {
    const data = transfer({
      [SCENE_ASSET_MIME]: JSON.stringify({ kind: 'behavior', id: 'x', displayName: 'x' }),
    });
    expect(readDragPayload(data)).toBeNull();
  });

  it('refuses a payload missing an id or a display name', () => {
    expect(
      readDragPayload(transfer({ [SCENE_ASSET_MIME]: JSON.stringify({ kind: 'character' }) })),
    ).toBeNull();
    expect(
      readDragPayload(
        transfer({ [SCENE_ASSET_MIME]: JSON.stringify({ kind: 'character', id: 'a' }) }),
      ),
    ).toBeNull();
  });
});

describe('asset resolution', () => {
  it.each([
    [{ kind: 'character', id: 'a', displayName: 'A' }, { kind: 'character', characterId: 'a' }],
    [{ kind: 'camera', id: 'camera', displayName: 'C' }, { kind: 'camera' }],
    [
      { kind: 'light', id: 'spot', displayName: 'L' },
      { kind: 'light', lightType: 'spot' },
    ],
  ] as const)('resolves %o', (payload, expected) => {
    expect(assetOf(payload as SceneAssetDragPayload)).toEqual(expected);
  });

  it('refuses a light type the schema does not have', () => {
    expect(assetOf({ kind: 'light', id: 'area', displayName: 'L' })).toBeNull();
  });
});

describe('placement ids', () => {
  /*
   * A stable counter, not a random suffix: a test asserting on the id of a
   * dropped entity could not be written against `crate-7f3a`, and two runs of
   * the same interaction would produce documents that diff against each other.
   */
  it('is deterministic and collision-free', () => {
    expect(placementEntityId('crate', [])).toBe('crate');
    expect(placementEntityId('crate', [{ id: 'crate' }])).toBe('crate-2');
    expect(placementEntityId('crate', [{ id: 'crate' }, { id: 'crate-2' }])).toBe('crate-3');
    expect(placementEntityId('crate', [{ id: 'crate' }])).toBe(
      placementEntityId('crate', [{ id: 'crate' }]),
    );
  });
});
