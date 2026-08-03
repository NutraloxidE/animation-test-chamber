/**
 * The selection model, on its own.
 *
 * These assert the properties the UI is built on top of rather than the UI
 * itself: that an attachment resolves to its parent instance, that a deleted
 * instance falls back to the world root, and that nothing in the model can
 * express "selected instance" independently of the selection. If the union
 * ever grows a second writable source of truth, the derivation tests here are
 * what stop it from being quietly correct in one file and wrong in another.
 */
import { describe, expect, it } from 'vitest';
import {
  WORLD_SELECTION,
  reconcileSelection,
  sameSelection,
  sceneNodeKey,
  selectedInstanceId,
  type SceneSelection,
} from '../../../apps/web/src/selection/scene-selection.ts';

describe('scene selection', () => {
  it('derives no instance from world, terrain or camera selections', () => {
    expect(selectedInstanceId({ kind: 'world' })).toBeNull();
    expect(selectedInstanceId({ kind: 'terrain' })).toBeNull();
    expect(selectedInstanceId({ kind: 'camera' })).toBeNull();
  });

  it('derives the instance from an instance selection', () => {
    expect(selectedInstanceId({ kind: 'instance', instanceId: 'controlled-humanoid' })).toBe(
      'controlled-humanoid',
    );
  });

  it('derives the parent instance from an attachment selection', () => {
    // The shield belongs to an instance. Selecting it must target the same
    // instance every loadout edit targets, or "edit the shield" and "edit the
    // instance's shield" become two different operations.
    const selection: SceneSelection = {
      kind: 'attachment',
      instanceId: 'scripted-humanoid',
      slotId: 'shield',
    };
    expect(selectedInstanceId(selection)).toBe('scripted-humanoid');
  });

  it('keys nodes by stable identity, not by position', () => {
    expect(sceneNodeKey({ kind: 'world' })).toBe('world');
    expect(sceneNodeKey({ kind: 'instance', instanceId: 'a' })).toBe('instance:a');
    expect(sceneNodeKey({ kind: 'attachment', instanceId: 'a', slotId: 'shield' })).toBe(
      'attachment:a:shield',
    );
    // Two instances with the same slot are different nodes.
    expect(sceneNodeKey({ kind: 'attachment', instanceId: 'b', slotId: 'shield' })).not.toBe(
      sceneNodeKey({ kind: 'attachment', instanceId: 'a', slotId: 'shield' }),
    );
  });

  it('compares selections by identity rather than by reference', () => {
    expect(
      sameSelection({ kind: 'instance', instanceId: 'a' }, { kind: 'instance', instanceId: 'a' }),
    ).toBe(true);
    expect(
      sameSelection({ kind: 'instance', instanceId: 'a' }, { kind: 'instance', instanceId: 'b' }),
    ).toBe(false);
  });

  describe('reconciliation after a world edit', () => {
    it('keeps a selection whose instance still exists', () => {
      const selection: SceneSelection = { kind: 'instance', instanceId: 'a' };
      expect(reconcileSelection(selection, ['a', 'b'])).toBe(selection);
    });

    it('falls back to the world root when the selected instance is removed', () => {
      expect(reconcileSelection({ kind: 'instance', instanceId: 'a' }, ['b'])).toEqual(
        WORLD_SELECTION,
      );
    });

    it('falls back when the attachment parent is removed', () => {
      expect(
        reconcileSelection({ kind: 'attachment', instanceId: 'a', slotId: 'shield' }, ['b']),
      ).toEqual(WORLD_SELECTION);
    });

    it('leaves world, terrain and camera selections alone', () => {
      // These outlive any instance edit, which is exactly why the world root is
      // the fallback rather than "the first remaining instance" — a fallback
      // that picked an instance would move the user's focus to an object they
      // never clicked on.
      for (const selection of [
        { kind: 'world' },
        { kind: 'terrain' },
        { kind: 'camera' },
      ] as SceneSelection[]) {
        expect(reconcileSelection(selection, [])).toBe(selection);
      }
    });
  });
});
