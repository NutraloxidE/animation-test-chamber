/**
 * React's view of the document the Graph workspace edits.
 *
 * The naive binding is `useChamber((s) => s.graphProject())`, and it is a trap
 * for the same reason `useAnimationTarget` exists: the value is *derived*, so
 * it is a fresh object on every store read. zustand compares selector output by
 * identity, so every unrelated store update looks like a change, and panels
 * that write to the store from an effect — the graph and the timing panel both
 * subscribe to the engine and set state — turn that into a render loop rather
 * than merely a wasted render.
 *
 * So the subscriptions here are the *inputs*, and the document is memoized
 * against them.
 */
import { useMemo } from 'react';
import type { ResolvedProject } from '@atc/schema';
import { useChamber } from '../store.ts';

export function useGraphProject(): ResolvedProject {
  const graphTarget = useChamber((state) => state.graphTarget);
  const weaponModeId = useChamber((state) => state.motionBindingContext.weaponModeId);
  const selection = useChamber((state) => state.sceneSelection);
  const targetMode = useChamber((state) => state.animationTargetMode);
  // Bumped whenever the preview document changes, which is what makes an edited
  // transition or clip curve reach the panel.
  const revision = useChamber((state) => state.revision);

  return useMemo(
    () => useChamber.getState().graphProject(),
    // Every input the derivation reads. `revision` covers edits to the
    // documents behind an otherwise unchanged target.
    [graphTarget, weaponModeId, selection, targetMode, revision],
  );
}
