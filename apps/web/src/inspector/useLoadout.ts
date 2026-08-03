/**
 * The selected instance's loadout, as a stable value.
 *
 * `loadoutOf` builds a fresh object every call, which is correct for a
 * one-shot read but fatal inside a zustand selector: the store compares
 * snapshots by reference, so a selector that allocates re-renders forever.
 * (React says so out loud — "the result of getSnapshot should be cached" —
 * immediately before the update-depth error.)
 *
 * So the reactive inputs are selected as themselves and the derivation is
 * memoized here, once, rather than repeated at each call site with a different
 * chance of getting it wrong.
 */
import { useMemo } from 'react';
import { useChamber, type InstanceLoadout } from '../store.ts';

export function useLoadout(instanceId: string | null): InstanceLoadout | null {
  const world = useChamber((state) => state.stagedWorld);
  const equipment = useChamber((state) => state.canonicalProject.equipment);
  const loadoutOf = useChamber((state) => state.loadoutOf);
  // `world` and `equipment` are the only things a loadout is derived from, and
  // both are replaced rather than mutated, so identity is a sound dependency.
  return useMemo(
    () => loadoutOf(instanceId),
    [loadoutOf, instanceId, world, equipment],
  );
}
