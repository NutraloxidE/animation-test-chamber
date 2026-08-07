/**
 * Asset resolution (PLAN 21, 32.1).
 *
 * One function turns "a character plus four asset references" into the
 * ordinary project document the rest of the system has always worked with.
 * Keeping the whole pipeline in one place is the point: if resolution were
 * spread across the runtime, the panels and the exporter, "which override
 * wins" would have three answers.
 *
 * Order, weakest first:
 *
 *   base behaviour -> variant patches -> motion set bindings ->
 *   tuning profile -> character overrides -> preview session
 */
import type {
  AnimationClipDefinition,
  AnimationGraphDefinition,
  AnimationSubjectDefinition,
  AssetIssue,
  AssetReference,
  CanonicalPatch,
  CharacterDefinition,
  MotionSlotDefinition,
  ProjectDefinition,
  ResolvedProject,
  ResolvedValue,
  SkeletonDefinition,
} from '@atc/schema';
import { activeCharacter, referenceKey, referencesEqual } from '@atc/schema';
import { applyPatches } from './patch.ts';
import { checkMotionSetCompatibility } from './compatibility.ts';
import type { AnimationAssetRegistry } from './registry.ts';
import { resolveBehaviorAsset } from './variant.ts';

export interface ResolveRequest {
  registry: AnimationAssetRegistry;
  project: ProjectDefinition;
  /** Defaults to the project's active character. */
  characterId?: string;
  /**
   * An explicit character to resolve, for callers whose definition does not
   * live in `project.characters`.
   *
   * A Prefab's Animator component carries the same `CharacterAnimationAssignment`
   * a `CharacterDefinition` does, and resolving it must run the *same* engine —
   * a second resolver for Prefabs would be a second answer to "what does this
   * behaviour do". This field is how the GameObject runtime borrows this one
   * without inventing a character in the project document to hold the
   * assignment. Wins over `characterId` when both are given.
   */
  character?: CharacterDefinition;
  /** Unsaved chamber edits, applied last so the preview shows them. */
  previewOverrides?: readonly CanonicalPatch[];
}

export interface ResolveResult {
  project: ResolvedProject;
  issues: AssetIssue[];
}

/**
 * Canonical paths in the chamber are rooted at the project (`/graph/states/...`).
 * Behaviour and tuning patches are rooted at the graph. This converts between
 * them so the Save Destination dialog can offer both without the caller having
 * to know which root each destination uses.
 */
export function stripGraphPrefix(path: string): string {
  return path.startsWith('/graph/') ? path.slice('/graph'.length) : path;
}

export function addGraphPrefix(path: string): string {
  return path.startsWith('/graph/') ? path : `/graph${path}`;
}

/** Whether a chamber path addresses something a behaviour asset owns. */
export function isBehaviorPath(path: string): boolean {
  return path.startsWith('/graph/');
}

/** Whether a chamber path addresses something a clip asset owns. */
export function isClipPath(path: string): boolean {
  return path.startsWith('/clips/');
}

/**
 * Stand-in used when the rig reference cannot be honoured. Resolution reports
 * the issue and keeps going so the library can still open and show it; callers
 * that are about to start the engine refuse on the issue, not on a throw.
 */
const EMPTY_SKELETON: SkeletonDefinition = {
  schemaVersion: 2,
  id: 'unresolved-rig',
  height: 1.8,
  bones: [],
  leftFootBone: '',
  rightFootBone: '',
  hipsBone: '',
};

interface MotionResolution {
  bindings: Record<string, string>;
  contextualBindings: Record<string, Record<string, string>>;
  contextKeys: string[];
  clips: AnimationClipDefinition[];
  /** Resolved clip id -> the asset that supplied it (PLAN Part II §13). */
  clipAssetSources: Record<string, AssetReference>;
  issues: AssetIssue[];
}

/**
 * Slot -> clip id, for the default context and for every context the set binds.
 *
 * Every context is resolved, not just the active one. Resolving only the active
 * context would make the resolved document change whenever the weapon changed,
 * which would discard the chamber's edit history on a selector click. Contexts
 * are picked apart again at tick time by the motion resolver, where switching
 * is free.
 *
 * A slot resolves to its contextual binding, else its default binding, else it
 * walks the fallback chain. The chain is depth-limited rather than
 * cycle-detected here because `checkMotionSetCompatibility` already reports the
 * cycle properly; this guard only exists so a bad asset cannot hang the load.
 */
function resolveMotionSet(
  registry: AnimationAssetRegistry,
  motionSetReference: AssetReference,
  slots: readonly MotionSlotDefinition[],
): MotionResolution {
  const empty = { bindings: {}, contextualBindings: {}, contextKeys: [], clips: [], clipAssetSources: {} };
  const issues: AssetIssue[] = [...registry.checkReference(motionSetReference)];
  if (issues.length > 0) return { ...empty, issues };

  const motionSet = registry.getMotionSet(motionSetReference);
  const bindings: Record<string, string> = {};
  const clipsById = new Map<string, AnimationClipDefinition>();
  const clipAssetSources = new Map<string, AssetReference>();

  const fallbackFor = new Map(
    motionSet.fallbackBindings.map((entry) => [entry.missingSlot, entry.fallbackSlot]),
  );
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));

  const bindingFor = (slotId: string, contextKey?: string): AssetReference | undefined => {
    const contextual = contextKey
      ? motionSet.bindings.find(
          (binding) => binding.motionSlot === slotId && binding.contextualKey === contextKey,
        )
      : undefined;
    const fallbackBinding = motionSet.bindings.find(
      (binding) => binding.motionSlot === slotId && binding.contextualKey === undefined,
    );
    return (contextual ?? fallbackBinding)?.clip;
  };

  const resolveSlot = (
    slotId: string,
    contextKey?: string,
    depth = 0,
  ): AssetReference | undefined => {
    if (depth > 8) return undefined;
    const direct = bindingFor(slotId, contextKey);
    if (direct) return direct;
    const next = fallbackFor.get(slotId) ?? slotById.get(slotId)?.fallbackSlot;
    return next ? resolveSlot(next, contextKey, depth + 1) : undefined;
  };

  // Unkeyed bindings are the default empty-hands context. Expose that context
  // alongside authored overrides so a Motion Set does not lose its base takes
  // (notably Universal Base's punch) from the native context selector.
  const contextKeys = [
    ...new Set(
      ['unarmed', ...motionSet.bindings
        .map((binding) => binding.contextualKey)]
        .filter((key): key is string => key !== undefined),
    ),
  ].sort();

  // Every slot the behaviour declares, plus anything the set binds beyond them:
  // an extra binding is not an error, and hiding it would make the library's
  // "unused binding" view lie.
  const allSlotIds = new Set<string>([
    ...slots.map((slot) => slot.id),
    ...motionSet.bindings.map((binding) => binding.motionSlot),
  ]);

  const contextualBindings: Record<string, Record<string, string>> = {};

  const bind = (slotId: string, contextKey?: string): void => {
    const clipReference = resolveSlot(slotId, contextKey);
    if (!clipReference) return;
    const clipIssues = registry.checkReference(clipReference);
    if (clipIssues.length > 0) {
      issues.push(...clipIssues);
      return;
    }
    const clipAsset = registry.getClip(clipReference);
    const clipId = clipAsset.clip.id;

    // Two different assets resolving to the same clip id would make "which
    // asset does this clip patch belong to" ambiguous — refused here, at
    // resolution time, rather than guessed at when a save tries to answer it.
    const existingSource = clipAssetSources.get(clipId);
    if (existingSource && !referencesEqual(existingSource, clipReference)) {
      issues.push({
        code: 'duplicate-resolved-clip-id',
        severity: 'error',
        message:
          `resolved clip id "${clipId}" is supplied by two different assets: ` +
          `${referenceKey(existingSource)} and ${referenceKey(clipReference)}`,
        reference: clipReference,
      });
      return;
    }
    clipAssetSources.set(clipId, clipReference);

    clipsById.set(clipId, clipAsset.clip);
    if (contextKey === undefined) {
      bindings[slotId] = clipId;
    } else {
      (contextualBindings[contextKey] ??= {})[slotId] = clipId;
    }
  };

  for (const slotId of [...allSlotIds].sort()) {
    bind(slotId);
    for (const contextKey of contextKeys) bind(slotId, contextKey);
  }

  return {
    bindings,
    contextualBindings,
    contextKeys,
    clips: [...clipsById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    clipAssetSources: Object.fromEntries(clipAssetSources),
    issues,
  };
}

/**
 * Turns a character's asset references into a resolved project.
 *
 * Never throws on bad data: a project with a broken reference still needs to
 * open in the library so the human can see *what* is broken. Errors come back
 * in `issues`, and callers that must not start the engine check for them.
 */
export function resolveCharacterAnimation(request: ResolveRequest): ResolveResult {
  const character = characterFor(request);
  const { bundle, issues } = resolveCharacterAnimationBundle(request);
  return {
    project: materializeResolvedProject({ project: request.project, character, bundle }),
    issues,
  };
}

/** The character a request resolves for: the named one, or the active one. */
export function characterFor(request: ResolveRequest): CharacterDefinition {
  return (
    request.character ??
    request.project.characters.find((entry) => entry.id === request.characterId) ??
    activeCharacter(request.project)
  );
}

/**
 * Everything a resolution produces that does *not* depend on which character
 * asked for it.
 *
 * This split exists because of a specific bug. The world runtime caches
 * resolution so two instances of one character share it — but the thing being
 * cached used to be the whole `ResolvedProject`, which carries the character's
 * own `modelAssetPath`, capsule dimensions, id and display name. Two *different*
 * characters that happened to reference the same animation assets would then
 * receive each other's body. The bundle is the part that is genuinely
 * shareable; the wrapper around it is not.
 */
export interface ResolvedAnimationBundle {
  graph: AnimationGraphDefinition;
  clips: AnimationClipDefinition[];
  motionBindings: Record<string, string>;
  contextualMotionBindings: Record<string, Record<string, string>>;
  motionContextKeys: string[];
  clipAssetSources: Record<string, AssetReference>;
  resolution: ResolvedValue[];
  skeleton: SkeletonDefinition;
  rigCompatibilityKey: string;
}

export interface ResolveBundleResult {
  bundle: ResolvedAnimationBundle;
  issues: AssetIssue[];
}

export interface ResolvedAnimationSubject {
  subject: AnimationSubjectDefinition;
  bundle: ResolvedAnimationBundle;
}

export interface ResolveAnimationSubjectResult {
  resolved: ResolvedAnimationSubject;
  issues: AssetIssue[];
}

/** Character-free animation resolution for an exact Prefab Animator subject. */
export function resolveAnimationSubject(request: {
  subject: AnimationSubjectDefinition;
  animationRegistry: AnimationAssetRegistry;
  previewOverrides?: readonly CanonicalPatch[];
}): ResolveAnimationSubjectResult {
  const { bundle, issues } = resolveAnimationAssignmentBundle({
    registry: request.animationRegistry,
    assignment: request.subject.animator.assignment,
    previewOverrides: request.previewOverrides,
  });
  return { resolved: { subject: request.subject, bundle }, issues };
}

/**
 * Resolves the character-independent half.
 *
 * It still takes a whole `ResolveRequest` because it needs the character's
 * `animation` block to know *which* assets to resolve — but nothing it returns
 * carries the character's identity or body.
 */
export function resolveCharacterAnimationBundle(request: ResolveRequest): ResolveBundleResult {
  const character: CharacterDefinition = characterFor(request);
  return resolveAnimationAssignmentBundle({
    registry: request.registry,
    assignment: character.animation,
    previewOverrides: request.previewOverrides,
  });
}

function resolveAnimationAssignmentBundle(request: {
  registry: AnimationAssetRegistry;
  assignment: CharacterDefinition['animation'];
  previewOverrides?: readonly CanonicalPatch[];
}): ResolveBundleResult {
  const { registry, assignment } = request;

  const issues: AssetIssue[] = [];
  const resolution: ResolvedValue[] = [];

  const behavior = resolveBehaviorAsset(registry, assignment.behavior);
  issues.push(...behavior.issues);
  resolution.push(...behavior.resolved);

  let graph: AnimationGraphDefinition = behavior.graph;

  const motion = resolveMotionSet(
    registry,
    assignment.motionSet,
    behavior.asset.motionSlots ?? [],
  );
  issues.push(...motion.issues);
  for (const [slot, clipId] of Object.entries(motion.bindings)) {
    resolution.push({
      value: clipId,
      source: 'motion-set',
      sourceAsset: assignment.motionSet,
      canonicalPath: `/motionBindings/${slot}`,
    });
  }

  if (behavior.issues.length === 0 && motion.issues.length === 0) {
    const compatibility = checkMotionSetCompatibility(
      registry,
      behavior.asset,
      registry.getMotionSet(assignment.motionSet),
      assignment.rig,
    );
    issues.push(...compatibility.issues);
  }

  // Tuning: values only. Structural change is a variant's job, and saying so
  // here is what keeps a tuning profile from becoming a second, weaker variant.
  if (assignment.tuning) {
    const tuningIssues = registry.checkReference(assignment.tuning);
    if (tuningIssues.length > 0) {
      issues.push(...tuningIssues);
    } else {
      const tuning = registry.getTuning(assignment.tuning);
      const application = applyPatches(graph, tuning.patches, {
        source: 'tuning-profile',
        sourceAsset: assignment.tuning,
        requireExistingPath: true,
        valuesOnly: true,
      });
      graph = application.document as AnimationGraphDefinition;
      resolution.push(...application.resolved);
      for (const rejection of application.rejected) {
        issues.push({
          code:
            rejection.patch.op === 'set' ? 'invalid-patch-path' : 'tuning-changes-structure',
          severity: 'error',
          message: `tuning ${rejection.patch.op} ${rejection.patch.path}: ${rejection.reason}`,
          path: rejection.patch.path,
          reference: assignment.tuning,
        });
      }
    }
  }

  // Character overrides and preview edits address the resolved project, so they
  // are applied to a `{ graph, clips }` pair rather than to the graph alone.
  let animation: { graph: AnimationGraphDefinition; clips: AnimationClipDefinition[] } = {
    graph,
    clips: motion.clips,
  };

  for (const [source, patches] of [
    ['character-override', assignment.instanceOverrides],
    ['preview-session', request.previewOverrides ?? []],
  ] as const) {
    if (patches.length === 0) continue;
    const application = applyPatches(animation, patches, {
      source,
      requireExistingPath: source === 'character-override',
    });
    animation = application.document as typeof animation;
    resolution.push(...application.resolved);
    for (const rejection of application.rejected) {
      issues.push({
        code: 'invalid-patch-path',
        severity: 'error',
        message: `${source} ${rejection.patch.op} ${rejection.patch.path}: ${rejection.reason}`,
        path: rejection.patch.path,
      });
    }
  }

  // The skeleton comes from the rig asset, not the character, so two characters
  // on one rig cannot disagree about how many bones they have.
  const rigIssues = registry.checkReference(assignment.rig);
  issues.push(...rigIssues);
  const rig = rigIssues.length === 0 ? registry.getRig(assignment.rig) : undefined;

  const bundle: ResolvedAnimationBundle = {
    graph: animation.graph,
    clips: animation.clips,
    motionBindings: motion.bindings,
    contextualMotionBindings: motion.contextualBindings,
    motionContextKeys: motion.contextKeys,
    clipAssetSources: motion.clipAssetSources,
    resolution,
    skeleton: rig?.skeleton ?? EMPTY_SKELETON,
    rigCompatibilityKey: rig?.compatibilityKey ?? 'unresolved',
  };

  return { bundle, issues };
}

/**
 * Wraps a shared bundle in one character's resolved project.
 *
 * Cheap by design: the wrapper is a fresh object per character, and every value
 * inside it that is safe to share is shared *by reference*. Deep-cloning the
 * graph and clips here would fix the contamination and throw away the entire
 * point of the cache along with it.
 */
export function materializeResolvedProject(input: {
  project: ProjectDefinition;
  character: CharacterDefinition;
  bundle: ResolvedAnimationBundle;
}): ResolvedProject {
  const { project, character, bundle } = input;
  return {
    ...project,
    character: {
      ...character,
      skeleton: bundle.skeleton,
      rigCompatibilityKey: bundle.rigCompatibilityKey,
    },
    graph: bundle.graph,
    clips: bundle.clips,
    motionBindings: bundle.motionBindings,
    contextualMotionBindings: bundle.contextualMotionBindings,
    motionContextKeys: bundle.motionContextKeys,
    clipAssetSources: bundle.clipAssetSources,
    resolution: bundle.resolution,
  };
}

/**
 * The origin of one value in a resolved project, for the inspector's "where
 * did this come from" column and its Revert action.
 */
export function originOf(
  resolved: ResolvedProject,
  path: string,
): ResolvedValue | undefined {
  const graphRelative = stripGraphPrefix(path);
  // Last writer wins, matching the application order above.
  for (let i = resolved.resolution.length - 1; i >= 0; i -= 1) {
    const entry = resolved.resolution[i]!;
    if (entry.canonicalPath === path || entry.canonicalPath === graphRelative) return entry;
  }
  return undefined;
}
