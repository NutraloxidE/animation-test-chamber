/**
 * Planning a `SaveAnimationChangesRequest` (PLAN Part II §14-15).
 *
 * Pulled out of the API route so it can be tested directly, against an
 * in-memory registry and project, without a filesystem or an HTTP server in
 * the way. The route's only remaining job is: load state, call this, hand
 * the result to the repository transaction.
 *
 * Every code path through here ends in exactly one of two shapes — a
 * refusal (with a reason a human can read) or a plan (assets to publish,
 * plus the character's next animation assignment) — so a caller can never
 * end up with a staged patch that was neither applied nor explained.
 */
import type {
  AnimationAsset,
  AnimationClipAsset,
  AnimationClipDefinition,
  AnimationGraphDefinition,
  AnimationMotionSetAsset,
  AnimationTuningProfileAsset,
  AssetIssue,
  AssetReference,
  CanonicalPatch,
  CharacterAnimationAssignment,
  ProjectDefinition,
  SaveAnimationChangesRequest,
  VariantAnimationBehaviorAsset,
} from '@atc/schema';
import { bumpAssetVersion, referencesEqual } from '@atc/schema';
import { addGraphPrefix } from './resolver.ts';
import { resolveBehaviorAsset } from './variant.ts';
import { applyPatches } from './patch.ts';
import { computeContentHash, sealAsset } from './hashing.ts';
import { createBehaviorVariant, isVariantAsset } from './variant.ts';
import type { AnimationAssetRegistry } from './registry.ts';

export interface SaveAnimationChangesPlan {
  ok: true;
  assets: AnimationAsset[];
  assignment: CharacterAnimationAssignment;
  intent: string;
}

export interface SaveAnimationChangesRefusal {
  ok: false;
  status: 404 | 409;
  error: string;
  issues?: AssetIssue[];
}

export interface PlanSaveOptions {
  createdBy?: string;
  createdAt?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

const TUNING_REFUSAL =
  'Structural graph changes cannot be saved to a tuning profile — it stores value changes only. ' +
  'Choose a behaviour variant instead.';

/**
 * Refuses a tuning-profile save that carries anything a tuning profile cannot
 * store, or returns `null` if every patch is storable.
 *
 * Both halves of "storable" are checked here rather than left to the resolver:
 * the op must be `set`, and the path must already exist in the behaviour being
 * tuned. The resolver does reject both, but it rejects them at load time, on
 * an asset that has by then been published and pointed at — which turns a
 * mistake a human could have corrected into a broken character.
 */
function refuseUnstorableTuningPatches(
  registry: AnimationAssetRegistry,
  behavior: AssetReference,
  currentTuning: AnimationTuningProfileAsset,
  patches: readonly CanonicalPatch[],
): SaveAnimationChangesRefusal | null {
  const structural = patches.filter((patch) => patch.op !== 'set');
  if (structural.length > 0) {
    return {
      ok: false,
      status: 409,
      error: TUNING_REFUSAL,
      issues: structural.map((patch) => ({
        code: 'unsupported-tuning-patch',
        severity: 'error',
        message: `a tuning profile cannot ${patch.op} ${patch.path}; it stores value changes only`,
        path: patch.path,
      })),
    };
  }

  const resolved = resolveBehaviorAsset(registry, behavior);
  if (resolved.issues.some((issue) => issue.severity === 'error')) {
    return {
      ok: false,
      status: 409,
      error: 'the behaviour this tuning profile adjusts could not be resolved',
      issues: resolved.issues,
    };
  }

  // Applied on top of the patches this profile already carries, because that
  // is the document the new patches will actually be resolved against.
  const base = applyPatches(resolved.graph, currentTuning.patches, {
    source: 'tuning-profile',
    requireExistingPath: true,
    valuesOnly: true,
  });
  const application = applyPatches(base.document, patches, {
    source: 'tuning-profile',
    requireExistingPath: true,
    valuesOnly: true,
  });
  if (application.rejected.length > 0) {
    return {
      ok: false,
      status: 409,
      error:
        'one or more values this save adjusts do not exist in the behaviour being tuned; ' +
        'a tuning profile can only change values the behaviour already has',
      issues: application.rejected.map((rejection) => ({
        code: 'invalid-patch-path',
        severity: 'error',
        message: `tuning ${rejection.patch.op} ${rejection.patch.path}: ${rejection.reason}`,
        path: rejection.patch.path,
      })),
    };
  }

  return null;
}

export function planSaveAnimationChanges(
  registry: AnimationAssetRegistry,
  project: ProjectDefinition,
  request: SaveAnimationChangesRequest,
  options: PlanSaveOptions = {},
): SaveAnimationChangesPlan | SaveAnimationChangesRefusal {
  const character = project.characters.find((entry) => entry.id === request.characterId);
  if (!character) {
    return { ok: false, status: 404, error: `unknown character "${request.characterId}"` };
  }

  // A change that edits clip data cannot be silently folded into a
  // destination that only understands graph structure (a tuning profile, a
  // behaviour variant, the shared behaviour) — the whole point of a
  // separate clip destination is that the choice is explicit.
  if (request.clips.destination.kind === 'none' && request.clips.changes.length > 0) {
    return {
      ok: false,
      status: 409,
      error:
        'This change edits animation clip data. Choose either: Character override, or ' +
        'New clip version + new motion-set version.',
    };
  }
  if (request.graph.destination.kind === 'none' && request.graph.patches.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'This change edits behaviour graph data. Choose a destination for it.',
    };
  }

  const staleReferenceIssues = request.expected.assetReferences.flatMap((reference) =>
    registry.checkReference(reference),
  );
  if (staleReferenceIssues.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'one or more referenced assets changed underneath this edit',
      issues: staleReferenceIssues,
    };
  }

  const createdAt = options.createdAt ?? nowIso();
  const createdBy = options.createdBy ?? 'chamber-user';
  const assets: AnimationAsset[] = [];
  const overrides: CanonicalPatch[] = [...character.animation.instanceOverrides];
  let assignment: CharacterAnimationAssignment = character.animation;
  const intentParts: string[] = [];

  // ---- Graph ----
  const graphPatches = request.graph.patches;
  const graphVariantPatches = graphPatches.map((patch) => ({
    ...patch,
    path: addGraphPrefix(patch.path),
  }));

  switch (request.graph.destination.kind) {
    case 'none':
      break;
    case 'character-override':
      overrides.push(...graphVariantPatches);
      intentParts.push(`${graphPatches.length} graph patch(es) to character override`);
      break;
    case 'tuning-profile': {
      if (!character.animation.tuning) {
        return { ok: false, status: 409, error: 'this character has no tuning profile to extend' };
      }
      const current = registry.getTuning(character.animation.tuning);

      /*
       * A tuning profile stores value changes and nothing else. Patches it
       * cannot hold used to be dropped by a `filter()` and the save reported
       * as a success — the human was told their structural edit was saved
       * when it was not, and would find out at the point where the missing
       * change matters.
       *
       * Every patch in the request is checked before anything is built, and
       * one that cannot be stored refuses the whole request. Publishing the
       * subset that happens to be storable would be saving an edit nobody
       * asked for: a graph whose blend times moved but whose new state never
       * arrived is not "most of" the requested change.
       */
      const refusal = refuseUnstorableTuningPatches(registry, character.animation.behavior, current, graphPatches);
      if (refusal) return refusal;

      const version = bumpAssetVersion(current.metadata.version, 'patch');
      const next = sealAsset<AnimationTuningProfileAsset>({
        ...current,
        metadata: { ...current.metadata, version, createdAt, createdBy, contentHash: '' },
        patches: [...current.patches, ...graphPatches],
      });
      assets.push(next);
      assignment = {
        ...assignment,
        tuning: {
          assetType: 'animation-tuning',
          assetId: next.metadata.id,
          version,
          contentHash: computeContentHash(next),
        },
      };
      intentParts.push(`tuning profile ${next.metadata.id}@${version}`);
      break;
    }
    case 'new-behavior-variant': {
      const variant = createBehaviorVariant(registry, character.animation.behavior, graphVariantPatches, {
        newAssetId: request.graph.destination.newAssetId,
        displayName: request.graph.destination.displayName,
        createdBy,
        createdAt,
      });
      assets.push(variant);
      assignment = {
        ...assignment,
        behavior: {
          assetType: 'animation-behavior',
          assetId: variant.metadata.id,
          version: variant.metadata.version,
          contentHash: computeContentHash(variant),
        },
      };
      intentParts.push(`new behaviour variant ${variant.metadata.id}`);
      break;
    }
    case 'existing-behavior-variant':
    case 'shared-behavior': {
      const current = registry.getBehavior(character.animation.behavior);
      const version = bumpAssetVersion(current.metadata.version, 'patch');
      const next = isVariantAsset(current)
        ? sealAsset<VariantAnimationBehaviorAsset>({
            ...current,
            metadata: { ...current.metadata, version, createdAt, createdBy, contentHash: '' },
            derivation: {
              ...current.derivation,
              patches: [...current.derivation.patches, ...graphVariantPatches],
            },
          })
        : sealAsset<AnimationAsset>({
            ...current,
            metadata: { ...current.metadata, version, createdAt, createdBy, contentHash: '' },
            graph: applyPatches(current.graph, graphPatches, {
              source: 'behavior-variant',
              requireExistingPath: false,
            }).document as AnimationGraphDefinition,
          });
      assets.push(next as AnimationAsset);
      assignment = {
        ...assignment,
        behavior: {
          assetType: 'animation-behavior',
          assetId: next.metadata.id,
          version,
          contentHash: computeContentHash(next),
        },
      };
      intentParts.push(`behaviour ${next.metadata.id}@${version}`);
      break;
    }
  }

  // ---- Clips ----
  switch (request.clips.destination.kind) {
    case 'none':
      break;
    case 'character-override':
      for (const change of request.clips.changes) {
        overrides.push(
          ...change.patches.map((patch) => ({ ...patch, path: `/clips/${change.clipId}${patch.path}` })),
        );
      }
      if (request.clips.changes.length > 0) {
        intentParts.push(`${request.clips.changes.length} clip override(s)`);
      }
      break;
    case 'new-clip-versions-and-motion-set': {
      if (request.clips.changes.length === 0) break;
      const currentMotionSet = registry.getMotionSet(character.animation.motionSet);
      const motionSetVersion = bumpAssetVersion(currentMotionSet.metadata.version, 'patch');
      const newBindings = currentMotionSet.bindings.map((binding) => ({ ...binding }));
      const newClipAssets: AnimationClipAsset[] = [];

      for (const change of request.clips.changes) {
        const sourceIssues = registry.checkReference(change.sourceClip);
        if (sourceIssues.length > 0) {
          return {
            ok: false,
            status: 409,
            error: `clip source for "${change.clipId}" could not be resolved`,
            issues: sourceIssues,
          };
        }
        const sourceAsset = registry.getClip(change.sourceClip);
        if (sourceAsset.clip.id !== change.clipId) {
          return {
            ok: false,
            status: 409,
            error:
              `sourceClip for resolved clip "${change.clipId}" is "${sourceAsset.clip.id}" — ` +
              `this save no longer matches what it was built against`,
          };
        }
        const clipVersion = bumpAssetVersion(sourceAsset.metadata.version, 'patch');
        const application = applyPatches(sourceAsset.clip, change.patches, {
          source: 'behavior-variant',
          requireExistingPath: false,
        });
        if (application.rejected.length > 0) {
          return {
            ok: false,
            status: 409,
            error: `one or more patches to clip "${change.clipId}" could not be applied`,
            issues: application.rejected.map((rejection) => ({
              code: 'invalid-patch-path',
              severity: 'error',
              message: `${rejection.patch.op} ${rejection.patch.path}: ${rejection.reason}`,
              path: rejection.patch.path,
            })),
          };
        }
        const nextClipAsset = sealAsset<AnimationClipAsset>({
          ...sourceAsset,
          metadata: { ...sourceAsset.metadata, version: clipVersion, createdAt, createdBy, contentHash: '' },
          clip: application.document as AnimationClipDefinition,
        });
        newClipAssets.push(nextClipAsset);
        const newClipReference: AssetReference = {
          assetType: 'animation-clip',
          assetId: nextClipAsset.metadata.id,
          version: clipVersion,
          contentHash: computeContentHash(nextClipAsset),
        };
        // Only the bindings that currently point at this exact clip version
        // are moved — a contextual binding for a different weapon mode that
        // happens to bind the same slot is untouched.
        for (let index = 0; index < newBindings.length; index += 1) {
          if (referencesEqual(newBindings[index]!.clip, change.sourceClip)) {
            newBindings[index] = { ...newBindings[index]!, clip: newClipReference };
          }
        }
      }

      assets.push(...newClipAssets);
      const nextMotionSet = sealAsset<AnimationMotionSetAsset>({
        ...currentMotionSet,
        metadata: {
          ...currentMotionSet.metadata,
          version: motionSetVersion,
          createdAt,
          createdBy,
          contentHash: '',
        },
        bindings: newBindings,
      });
      assets.push(nextMotionSet);
      assignment = {
        ...assignment,
        motionSet: {
          assetType: 'animation-motion-set',
          assetId: nextMotionSet.metadata.id,
          version: motionSetVersion,
          contentHash: computeContentHash(nextMotionSet),
        },
      };
      intentParts.push(
        `${newClipAssets.length} clip version(s) + motion set ${nextMotionSet.metadata.id}@${motionSetVersion}`,
      );
      break;
    }
  }

  assignment = { ...assignment, instanceOverrides: overrides };

  return {
    ok: true,
    assets,
    assignment,
    intent: intentParts.length > 0 ? intentParts.join('; ') : 'save staged animation changes',
  };
}
