/**
 * Scopes one facade to one subtree.
 *
 * A React context rather than a module singleton, because the whole point of
 * the restoration is that the workspace edits *an* exact subject rather than
 * the application's current one. A singleton would put subject identity back
 * into global state, which is the shape of the problem this replaces.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { AnimationChamberFacade } from './AnimationChamberFacade.ts';

const AnimationChamberContext = createContext<AnimationChamberFacade | null>(null);

export function AnimationChamberProvider({
  facade,
  children,
}: {
  facade: AnimationChamberFacade;
  children: ReactNode;
}): JSX.Element {
  return (
    <AnimationChamberContext.Provider value={facade}>{children}</AnimationChamberContext.Provider>
  );
}

/**
 * The facade for the enclosing workspace.
 *
 * Returns null outside a provider rather than throwing, so the migration
 * bridge in `panels/chamber-source.ts` can fall back to the legacy store while
 * both paths exist. Native code should use `useAnimationChamberFacade`, which
 * treats absence as the bug it is.
 */
export function useOptionalAnimationChamberFacade(): AnimationChamberFacade | null {
  return useContext(AnimationChamberContext);
}

export function useAnimationChamberFacade(): AnimationChamberFacade {
  const facade = useContext(AnimationChamberContext);
  if (!facade) {
    throw new Error(
      'useAnimationChamberFacade was called outside an AnimationChamberProvider. ' +
        'The animation workspace must be mounted by the exact native route.',
    );
  }
  return facade;
}
