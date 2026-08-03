/**
 * Which Behavior the Graph workspace is editing — said out loud.
 *
 * The graph read one globally resolved project and edited whatever came back.
 * That is unambiguous in a world where every instance shares a behaviour and
 * silently wrong in one where they do not: the header said "Graph", the states
 * came from somewhere, and a change made through a canonical path landed in a
 * shared asset the user had not been told they were editing.
 *
 * `Follow Animation Target` keeps the common case free — the graph shows what
 * you have selected — while making the answer visible. Pinning an asset is for
 * editing a behaviour nothing in the world currently references.
 */
import type { AssetReference } from '@atc/schema';

export type GraphTarget =
  | { kind: 'follow-animation-target' }
  | { kind: 'asset'; behaviorRef: AssetReference };

export const FOLLOW_ANIMATION_TARGET: GraphTarget = { kind: 'follow-animation-target' };

/**
 * Which half of the details pane is showing.
 *
 * They used to be stacked: the transition inspector and the motion timing panel
 * both rendered, always, competing for the height the graph also wanted. They
 * are related but rarely simultaneously relevant, and selecting a transition
 * does not mean you stopped caring which clip the state plays.
 */
export type GraphDetailsTab = 'state' | 'transition' | 'motion';

/**
 * The contextual binding being inspected — deliberately not a loadout.
 *
 * Changing this changes which binding the panels resolve through. It does not
 * change what any instance is holding, does not stage a world edit and does not
 * dirty the world.
 */
export interface MotionBindingContext {
  weaponModeId: string;
  equipment: Record<string, boolean>;
}
