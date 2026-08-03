/**
 * React's view of the animation target.
 *
 * Resolution is a derivation, not stored state, so the naive binding is
 * `useChamber((s) => s.resolvedAnimationTarget())` — and that returns a fresh
 * object on every store update, which makes the selector compare unequal every
 * time and re-render the workspace whenever anything in the app changes. So the
 * reactive subscriptions here are the *inputs* (mode, selection, world,
 * revision), and the resolution is memoized against them. Same value, and it
 * only changes when something it depends on does.
 */
import { useMemo } from 'react';
import { useChamber } from '../../store.ts';
import { resolveAnimationTargetMode, type AnimationTargetResolution } from './animation-target.ts';
import type { AnimationSubject, AnimationTargetResult } from './resolve-animation-target.ts';

export interface AnimationTargetView {
  resolution: AnimationTargetResolution;
  resolved: AnimationTargetResult | null;
  subject: AnimationSubject | null;
}

export function useAnimationTarget(): AnimationTargetView {
  const mode = useChamber((state) => state.animationTargetMode);
  const selection = useChamber((state) => state.sceneSelection);
  const world = useChamber((state) => state.stagedWorld);
  /*
   * Which *kind* of thing is being previewed.
   *
   * Character Lab previews a Character Definition — there is no Instance, and
   * requiring one would mean placing a character into a world just to look at
   * it. World previews an Instance, which is the thing that has a loadout, a
   * transform and a running simulation. One workspace, two subject adapters.
   */
  const primaryWorkspace = useChamber((state) => state.primaryWorkspace);
  const editingCharacterId = useChamber((state) => state.editingCharacterId);
  // Bumped whenever the preview document changes, which is what makes an edited
  // clip duration reach the panel without a second subscription per asset.
  const revision = useChamber((state) => state.revision);

  return useMemo(() => {
    if (primaryWorkspace === 'character-lab') {
      return {
        // Character Lab has no target *mode*: the subject is whatever the
        // header says is being edited, so Follow/Pin would be a control with
        // one legal value.
        resolution: {
          instanceId: editingCharacterId,
          issue: null,
          pinned: false,
        } satisfies AnimationTargetResolution,
        resolved: useChamber.getState().resolvedCharacterLabTarget(),
        subject: { kind: 'character-lab', characterId: editingCharacterId },
      };
    }
    const resolution = resolveAnimationTargetMode(mode, selection, world);
    return {
      resolution,
      resolved: resolution.instanceId ? useChamber.getState().resolvedAnimationTarget() : null,
      subject: resolution.instanceId
        ? ({ kind: 'world-instance', instanceId: resolution.instanceId } as const)
        : null,
    };
    // `revision` is a deliberate dependency: it is the signal that the resolved
    // documents behind an unchanged instance id have been rebuilt.
  }, [mode, selection, world, revision, primaryWorkspace, editingCharacterId]);
}
