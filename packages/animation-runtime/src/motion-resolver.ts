/**
 * Motion resolution (PLAN 32.2).
 *
 * The graph runtime used to search a clip array for `state.clipId`. It now asks
 * this instead, which is the whole mechanical difference between "a character
 * owns its animation" and "a character is handed one". The behaviour names a
 * slot; something else decides which clip that is.
 */
import type {
  AnimationClipDefinition,
  AnimationGraphDefinition,
  StateDefinition,
} from '@atc/schema';

export interface AnimationContext {
  /** Contextual binding selector — the weapon mode, in the demo project. */
  contextKey?: string;
}

export interface MotionResolver {
  resolve(motionSlot: string, context: AnimationContext): AnimationClipDefinition | undefined;
  /** Slot ids this resolver can satisfy. Used by validation and the library. */
  boundSlots(): string[];
}

/**
 * The slot a state plays in a given context.
 *
 * Contextual *slots* are rarer than contextual *bindings* — normally a weapon
 * changes which clip fills `action.primary.01`, not which slot the state plays.
 * Both are supported because "this weapon uses a structurally different motion"
 * is a real case, and folding it into bindings would have required a slot per
 * weapon in the shared behaviour.
 */
export function slotForState(state: StateDefinition, context: AnimationContext): string {
  if (context.contextKey) {
    const contextual = state.contextualMotionSlots?.[context.contextKey];
    if (contextual) return contextual;
  }
  return state.motionSlot;
}

/**
 * A resolver over a resolved project's bindings.
 *
 * Context selection happens here rather than during asset resolution, so that
 * switching weapon is a runtime decision and not a document change. The
 * resolved project carries every context's bindings; picking one is a map
 * lookup on the tick that needs it.
 */
export class BoundMotionResolver implements MotionResolver {
  private readonly clipsById: Map<string, AnimationClipDefinition>;

  constructor(
    private readonly bindings: Record<string, string>,
    clips: readonly AnimationClipDefinition[],
    private readonly contextualBindings: Record<string, Record<string, string>> = {},
  ) {
    this.clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  }

  resolve(
    motionSlot: string,
    context: AnimationContext = {},
  ): AnimationClipDefinition | undefined {
    const contextual = context.contextKey
      ? this.contextualBindings[context.contextKey]?.[motionSlot]
      : undefined;
    const clipId = contextual ?? this.bindings[motionSlot];
    return clipId === undefined ? undefined : this.clipsById.get(clipId);
  }

  boundSlots(): string[] {
    return Object.keys(this.bindings).sort();
  }
}

/**
 * The clip id a state plays in a resolved document.
 *
 * Panels used to read `state.clipId` directly. They now ask through the
 * binding, which is one indirection but the only honest one: the state genuinely
 * does not know, and every caller that pretended otherwise would have had to be
 * found again the first time a character wanted a different clip.
 */
/**
 * The part of a document motion resolution actually reads.
 *
 * Named so that resolving a clip does not require a whole `ResolvedProject`,
 * and therefore does not require a Character. The animation chamber edits an
 * exact Prefab Animator subject whose document has no character in it, and
 * these four fields are the entire question "which clip does this state play".
 * `ResolvedProject` satisfies it structurally, so existing callers are
 * unaffected.
 */
export interface MotionResolutionDocument {
  graph: AnimationGraphDefinition;
  clips: AnimationClipDefinition[];
  motionBindings: Record<string, string>;
  contextualMotionBindings: Record<string, Record<string, string>>;
}

export function clipIdForState(
  project: MotionResolutionDocument,
  stateId: string,
  contextKey?: string,
): string | undefined {
  const state = project.graph.states.find((entry) => entry.id === stateId);
  if (!state) return undefined;
  const slot = slotForState(state, contextKey ? { contextKey } : {});
  return contextKey
    ? (project.contextualMotionBindings[contextKey]?.[slot] ?? project.motionBindings[slot])
    : project.motionBindings[slot];
}

export function clipForState(
  project: MotionResolutionDocument,
  stateId: string,
  contextKey?: string,
): AnimationClipDefinition | undefined {
  const clipId = clipIdForState(project, stateId, contextKey);
  return clipId === undefined ? undefined : project.clips.find((clip) => clip.id === clipId);
}

export function motionResolverFor(project: MotionResolutionDocument): MotionResolver {
  return new BoundMotionResolver(
    project.motionBindings,
    project.clips,
    project.contextualMotionBindings,
  );
}
