/**
 * Selector access to the enclosing subject's facade.
 *
 * Deliberately the same call shape as the legacy `useChamber`, so a preserved
 * panel changes its import and nothing else. That is the compatibility decision
 * the work package asks for (§15): the panels are preservation targets, and the
 * data source is the only thing allowed to move.
 */
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { resolveWeaponMode } from '@atc/animation-runtime';
import { useAnimationChamberFacade } from './AnimationChamberProvider.tsx';
import type {
  AnimationChamberActions,
  AnimationChamberState,
} from './AnimationChamberFacade.ts';
import type { AnimationChamberDocument } from './AnimationChamberDocument.ts';

export type AnimationChamberSlice = AnimationChamberState & AnimationChamberActions;

export function useAnimationChamber<T>(selector: (state: AnimationChamberSlice) => T): T {
  const facade = useAnimationChamberFacade();
  return useStore(facade.store, selector);
}

/**
 * The document, resolved for the current motion context.
 *
 * The legacy `useWeaponProject()` resolved a weapon mode out of a static
 * catalogue; a subject's contexts come from its resolved Motion Set instead
 * (§16.4), so the same idea keeps its role and loses its Character assumption.
 */
export function useAnimationChamberDocument(): AnimationChamberDocument {
  const document = useAnimationChamber((state) => state.project);
  const motionContextId = useAnimationChamber((state) => state.motionContextId);
  return useMemo(
    () => resolveWeaponMode(document, motionContextId),
    [document, motionContextId],
  );
}
