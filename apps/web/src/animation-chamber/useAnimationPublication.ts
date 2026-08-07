/**
 * The publication view, subscribed from React.
 *
 * The controller is not a Zustand store. It could have been, but its state is
 * a decision in progress rather than a value the panels select from, and
 * folding it into the chamber store would have made "has not chosen a
 * destination" and "chose publish-only" the same empty array.
 *
 * `useSyncExternalStore` is the right shape for it: the controller already
 * publishes a stable snapshot, rebuilt only when something actually changed, so
 * this neither tears nor loops.
 */
import { useSyncExternalStore } from 'react';
import { useAnimationChamber } from './useAnimationChamber.ts';
import type { AnimationPublicationView } from './AnimationPublicationController.ts';

export function useAnimationPublication(): AnimationPublicationView {
  const controller = useAnimationChamber((state) => state.publication);
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.snapshot(),
    () => controller.snapshot(),
  );
}
