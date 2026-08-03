/**
 * Which instance the animation tools are talking about.
 *
 * The preview used to hold one nullable instance id, which had to answer two
 * different questions with one value: "whose animation am I looking at?" and
 * "did the user deliberately nail this down?". A single id cannot distinguish
 * "no target yet" from "the user cleared it on purpose", so the workspace
 * demanded an explicit *Use selected instance* click before it would do
 * anything — the common path paying for the rare one.
 *
 * Two modes separate those questions. Follow Selection derives the target from
 * `SceneSelection` every time it is asked, so there is no second copy of the
 * selection to fall out of date. Pinned stores an id precisely because the user
 * asked for one that outlives their next click.
 */
import type { WorldDefinition } from '@atc/schema';
import { selectedInstanceId, type SceneSelection } from '../../selection/scene-selection.ts';

export type AnimationTargetMode =
  | { kind: 'follow-selection' }
  | { kind: 'pinned'; instanceId: string };

export const FOLLOW_SELECTION: AnimationTargetMode = { kind: 'follow-selection' };

/**
 * Why there is no effective target, when there is none.
 *
 * `null` would collapse three different situations — nothing selected, a
 * non-instance selected, a pinned instance that has since been deleted — into
 * one blank panel. The third is the one that matters: silently falling back to
 * some other instance is exactly how a user ends up previewing a character they
 * never chose, and reporting "no target" would make a deletion look like a
 * selection problem.
 */
export type AnimationTargetIssue =
  | { kind: 'no-selection' }
  | { kind: 'selection-not-an-instance' }
  | { kind: 'pinned-target-missing'; instanceId: string };

export interface AnimationTargetResolution {
  instanceId: string | null;
  issue: AnimationTargetIssue | null;
  pinned: boolean;
}

/**
 * The instance the animation tools act on, given a mode and the current scene.
 *
 * An attachment selection resolves to its parent instance, matching
 * `selectedInstanceId` — clicking the shield and clicking the character it
 * hangs off mean the same object everywhere else in the app, and animation is
 * not the place to invent a second rule.
 */
export function resolveAnimationTargetMode(
  mode: AnimationTargetMode,
  selection: SceneSelection,
  world: WorldDefinition,
): AnimationTargetResolution {
  if (mode.kind === 'pinned') {
    const exists = world.instances.some((instance) => instance.id === mode.instanceId);
    return exists
      ? { instanceId: mode.instanceId, issue: null, pinned: true }
      : {
          instanceId: null,
          issue: { kind: 'pinned-target-missing', instanceId: mode.instanceId },
          pinned: true,
        };
  }

  const instanceId = selectedInstanceId(selection);
  if (instanceId === null) {
    return {
      instanceId: null,
      issue:
        selection.kind === 'world'
          ? { kind: 'no-selection' }
          : { kind: 'selection-not-an-instance' },
      pinned: false,
    };
  }
  // Follow Selection never reports a missing target: `reconcileSelection`
  // already moves the scene selection off a deleted instance, so a stale id
  // here would mean the selection model was wrong, not the animation target.
  return world.instances.some((instance) => instance.id === instanceId)
    ? { instanceId, issue: null, pinned: false }
    : { instanceId: null, issue: { kind: 'no-selection' }, pinned: false };
}

/** Just the id. For callers that have nothing to say about why it is null. */
export function effectiveAnimationTarget(
  mode: AnimationTargetMode,
  selection: SceneSelection,
  world: WorldDefinition,
): string | null {
  return resolveAnimationTargetMode(mode, selection, world).instanceId;
}

export function describeAnimationTargetIssue(issue: AnimationTargetIssue): string {
  switch (issue.kind) {
    case 'no-selection':
      return 'Select an instance in the Hierarchy to choose an animation target.';
    case 'selection-not-an-instance':
      return 'The selected scene object is not an instance, so it has no animation.';
    case 'pinned-target-missing':
      return `Pinned target missing: “${issue.instanceId}” is no longer in the world.`;
  }
}
