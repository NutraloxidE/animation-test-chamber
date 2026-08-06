/**
 * What an Animator Component actually plays (§10.4).
 *
 * The Animator used to be a *fact* — the projection reported that one existed,
 * named its assignment, and stopped there. Nothing turned that fact into a
 * moving skeleton, so a Prefab carrying `ModelRenderer + Animator` rendered as
 * a mesh frozen in its bind pose while every check that asked "is there an
 * Animator?" answered yes.
 *
 * This file closes that gap without building a second animation engine. It runs
 * the *existing* resolver — behavior asset, motion set, rig, tuning — and
 * flattens its output into the one question a renderer has to answer per frame:
 *
 *   graph state id -> which imported take plays, from which file, looping or not
 *
 * That is the same shape `resolveRigEditorCharacterPresentation` produces for
 * the Rig Editor, derived the same way, and deliberately so: a Prefab's Animator
 * carries the same `CharacterAnimationAssignment` a Character does, so playback
 * resolution that disagreed between the two screens would be the split this
 * whole migration exists to close, one layer down.
 *
 * Nothing here touches Three.js, the DOM or a clock. The property worth testing
 * is "this assignment yields exactly these takes at these times", and that needs
 * no canvas — which is what lets `harness:scene-gameobject-cutover` assert
 * visible playback in Node, in milliseconds, against the canonical project.
 */
import { DEFAULT_MOTION_CONTEXT_KEY } from '@atc/schema';
import type {
  AssetIssue,
  CharacterAnimationAssignment,
  CharacterDefinition,
  ExternalAnimationSource,
  ProjectDefinition,
} from '@atc/schema';
import {
  materializeResolvedProject,
  resolveCharacterAnimationBundle,
  type AnimationAssetRegistry,
  type ResolvedAnimationBundle,
} from '@atc/animation-asset-runtime';
import { resolveWeaponMode } from '@atc/animation-runtime';

/**
 * Everything a renderer needs to play one Animator, keyed by graph state.
 *
 * Keyed by *state id*, never by a filename convention and never by a clip name
 * the renderer guessed: the canonical chain is
 * `state -> motion slot -> motion set -> clip asset -> take`, and every link of
 * it is resolved here so the renderer only ever looks a state up.
 */
export interface AnimatorPlaybackPlan {
  /** Graph state id -> the imported take that state plays, in this context. */
  takeByStateId: Record<string, ExternalAnimationSource>;
  /** Canonical loop flag per state, so the renderer never re-derives it. */
  loopByStateId: Record<string, boolean>;
  /** Authored clip length per state, in seconds. Drives normalized time. */
  durationByStateId: Record<string, number>;
  /** Distinct files the takes live in, sorted. What a loader must fetch. */
  sourceFiles: string[];
  /**
   * Where an Animator with no CharacterMotor starts and stays.
   *
   * The locomotion layer's authored `defaultState`. An Animator-only object has
   * no intent driving it through the graph, so "the state the graph opens in" is
   * the honest answer rather than a state picked by the renderer.
   */
  initialStateId: string;
  /** The motion context this plan was collapsed for. */
  contextKey: string;
}

export interface ResolveAnimatorPlaybackResult {
  plan: AnimatorPlaybackPlan;
  /** The shared, character-independent half. Reused rather than resolved twice. */
  bundle: ResolvedAnimationBundle;
  issues: AssetIssue[];
}

/** The motion slot a state uses in this motion context. */
function slotFor(
  state: { motionSlot: string; contextualMotionSlots?: Record<string, string> },
  contextKey: string,
): string {
  return state.contextualMotionSlots?.[contextKey] ?? state.motionSlot;
}

/**
 * Resolves one Animator assignment into a playback plan.
 *
 * `identity` names the object and the Component in every issue this produces.
 * "A clip is missing" is useless on a Scene with forty objects; "`crate-02`'s
 * Animator `animator` binds slot `locomotion-walk` to a clip with no imported
 * take" is a thing somebody can fix.
 */
export function resolveAnimatorPlayback(input: {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  assignment: CharacterAnimationAssignment;
  /** The context the Animator opens in, when it names one. */
  defaultContextKey?: string | undefined;
  identity: { gameObjectId: string; displayName: string; componentId: string };
}): ResolveAnimatorPlaybackResult {
  const { registry, project, assignment, identity } = input;

  /*
   * A `CharacterDefinition` view of the Animator alone.
   *
   * The resolver's entry point takes a character because the *assignment* is
   * the part it reads, and a Prefab node carries exactly that. The body fields
   * below are placeholders the animation half never looks at — the model and
   * capsule come from this node's own Components, resolved elsewhere — so
   * inventing them here cannot leak a body into the resolution.
   */
  const character: CharacterDefinition = {
    schemaVersion: 2,
    id: identity.gameObjectId,
    displayName: identity.displayName,
    model: { kind: 'procedural-humanoid', presetId: 'navigator' },
    capsuleRadius: 0.3,
    capsuleHeight: 1.8,
    animation: assignment,
  };

  const resolved = resolveCharacterAnimationBundle({ registry, project, character });
  const issues: AssetIssue[] = [...resolved.issues];
  const materialized = materializeResolvedProject({
    project,
    character,
    bundle: resolved.bundle,
  });

  /*
   * One collapse of the motion context, through the same function the Rig
   * Editor and the simulation use. A second collapse written here would be a
   * second answer to "which clip does this state play in sword mode".
   *
   * The fallback is the *simulation's* default rather than "the first context
   * the bundle happens to list". Picking the first would mean a Prefab whose
   * Animator names no context played its `magic` clips while the simulation it
   * is attached to stepped `unarmed` — the right state, the wrong animation, and
   * nothing on screen to say which half is wrong.
   */
  const contextKey = input.defaultContextKey ?? DEFAULT_MOTION_CONTEXT_KEY;
  const forContext = resolveWeaponMode(materialized, contextKey);
  const clipById = new Map(forContext.clips.map((clip) => [clip.id, clip]));

  const takeByStateId: Record<string, ExternalAnimationSource> = {};
  const loopByStateId: Record<string, boolean> = {};
  const durationByStateId: Record<string, number> = {};

  for (const state of forContext.graph.states) {
    loopByStateId[state.id] = state.loop;
    const clipId = forContext.motionBindings[slotFor(state, contextKey)];
    const clip = clipId === undefined ? undefined : clipById.get(clipId);
    if (!clip) continue;
    durationByStateId[state.id] = clip.durationSec;
    /*
     * A clip with no external source is procedural, and that absence is
     * meaningful (§10.7): the state genuinely has no skeletal take, and filling
     * the gap with a placeholder would make a procedural stand-in look like
     * proof of imported animation.
     */
    if (clip.externalSource) takeByStateId[state.id] = clip.externalSource;
  }

  /*
   * The base layer, by authored `order` rather than by the name "locomotion".
   * "Higher index composites on top" is the contract `LayerDefinition` states,
   * so the lowest one is the layer that always has something playing — and a
   * behaviour asset that named its base layer something else would still
   * resolve, which a hard-coded id would not.
   */
  const baseLayer = [...forContext.graph.layers].sort((a, b) => a.order - b.order)[0];
  const initialStateId = baseLayer?.defaultState ?? forContext.graph.states[0]?.id ?? '';

  return {
    plan: {
      takeByStateId,
      loopByStateId,
      durationByStateId,
      sourceFiles: [
        ...new Set(Object.values(takeByStateId).map((source) => source.assetPath)),
      ].sort(),
      initialStateId,
      contextKey,
    },
    bundle: resolved.bundle,
    issues,
  };
}

/**
 * The take one state plays, or `undefined` with the reason recorded.
 *
 * Split out so both the pure projection and the browser renderer answer the
 * question the same way. A renderer that fell back to "the first clip in the
 * GLTF" when the lookup missed would put *something* on screen for every
 * broken binding, which is the failure mode §10.5 forbids by name.
 */
export function takeForState(
  plan: AnimatorPlaybackPlan,
  stateId: string,
): ExternalAnimationSource | undefined {
  return plan.takeByStateId[stateId];
}
