/**
 * The boundary between "I changed something in the browser" and "the
 * repository changed".
 *
 * The legacy path crossed that boundary with `commit(intent)`: one button, one
 * destination, project.json. It worked because the legacy workspace edited a
 * Character, and a Character lived in project.json. The native workspace edits
 * an exact Prefab node Animator whose values come from several immutable
 * assets, so there is no single destination and no honest way to invent one.
 *
 * What replaces it is a *plan*, and the plan's whole reason to exist is one
 * equality:
 *
 *   displayed targets === request.targetPrefabIds === response changedPrefabIds
 *
 * They are equal by construction rather than by review, because the surface
 * renders from the same request object that is sent, and the server re-derives
 * the same plan from it with the same pure function
 * (`createAnimationPublicationPlan`). A confirmation dialog computed from a
 * separately-built prose string is the failure this design refuses: it can say
 * "this affects all three Prefabs" while the request re-points one.
 *
 * Two rules are load-bearing and are enforced here rather than in the UI:
 *
 *   - **no default blast radius.** Opening the plan selects nothing. Not the
 *     current holder, not publish-only, not everything. A zero-target request
 *     is legal only after the human explicitly chose publish-only, which is a
 *     different state from "has not chosen yet" (§7.4);
 *   - **staleness refuses with zero writes.** The human approved a blast radius
 *     drawn from a snapshot. If the source hash, the repository revision or the
 *     holder set moved since, silently including or excluding the difference
 *     are both wrong answers to a question only the human can settle.
 */
import type {
  AnimationAsset,
  AnimationBehaviorAsset,
  AssetReference,
  GameObjectPrefabReference,
  PublishAnimationAndUpdatePrefabsRequest,
} from '@atc/schema';
import { referenceKey } from '@atc/schema';
import type { CanonicalPath } from '@atc/runtime-core';
import type { EditSession } from '@atc/editor-core';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import type { PrefabAssetRegistry } from '@atc/prefab-runtime';
import {
  changedPrefabIdsEqualTargets,
  createAnimationPublicationPlan,
  describePrefabUsage,
  prefabHoldersOfAnimationAsset,
  type AnimationPublicationPlan,
} from '@atc/prefab-runtime';
import type { AnimationChamberDocument } from './AnimationChamberDocument.ts';
import {
  blockingFindings,
  summarizeStagedDomains,
  type AnimationPublicationDomainSummary,
  type StagedPathOwnership,
} from './animation-publication-state.ts';

/** Where the human is in the publication decision. */
export type AnimationPublicationStage =
  | 'closed'
  /** Open, nothing chosen. A request cannot be built from this state. */
  | 'choosing'
  /** Explicitly publish-only: a new asset version, no Prefab adopts it. */
  | 'publish-only'
  /** One or more exact holders named. */
  | 'targets-chosen'
  | 'submitting'
  | 'published'
  | 'refused';

export interface AnimationPublicationConflict {
  code: string;
  message: string;
}

export interface AnimationPublicationResult {
  ok: boolean;
  /** What the transaction actually wrote, derived server-side. */
  changedPrefabIds: string[];
  publishedAnimation?: AssetReference;
  publishedPrefabs: { assetId: string; version: string; contentHash: string }[];
  conflicts: AnimationPublicationConflict[];
}

export interface AnimationPublicationView {
  stage: AnimationPublicationStage;
  /** One row per owning domain, blocking rows included (§7.1). */
  domains: AnimationPublicationDomainSummary[];
  /** Staged paths with no exact owner. Non-empty means publication refuses. */
  blocking: StagedPathOwnership[];
  /** The animation asset a publication would create the next version of. */
  source: AssetReference | null;
  /** Every Prefab that currently holds `source`, from the live registry. */
  holders: GameObjectPrefabReference[];
  /** Exactly what the human named. Empty is meaningful only in `publish-only`. */
  selectedPrefabIds: string[];
  /** Built from the current selection. `null` when a request cannot exist yet. */
  plan: AnimationPublicationPlan | null;
  result: AnimationPublicationResult | null;
  log: string[];
  /** `false` means the deployment cannot write, and must not claim it did. */
  backendOnline: boolean | null;
}

export interface AnimationPublicationActions {
  openPublication(): void;
  closePublication(): void;
  togglePublicationTarget(prefabId: string): void;
  choosePublishOnly(): void;
  submitPublication(intent: string): Promise<void>;
}

export interface PublicationControllerInput {
  session: EditSession<AnimationChamberDocument>;
  prefabRegistry: PrefabAssetRegistry;
  animationRegistry: AnimationAssetRegistry;
  projectRevisionId: string;
  /** Injected so tests drive the whole path without a network. */
  submit?: (request: PublishAnimationAndUpdatePrefabsRequest) => Promise<PublicationResponse>;
  backendAvailable: () => Promise<boolean>;
}

export interface PublicationResponse {
  status: number;
  body: {
    ok?: boolean;
    issues?: { path?: string; message: string; keyword?: string }[];
    changedTargets?: { prefabIds?: string[] };
    published?: {
      animation: AssetReference;
      prefabs: { assetId: string; version: string; contentHash: string }[];
    };
  };
}

/**
 * Which asset a publication would advance.
 *
 * Deliberately singular and deliberately strict: the API publishes *one*
 * animation asset version and re-points holders at it. A session that staged
 * changes across two animation assets has two publications to make, and
 * pretending otherwise would let one submit silently drop the other. So a
 * mixed staged set produces no source, and the surface says which domains are
 * involved rather than picking one.
 */
export function publicationSource(
  stagedPaths: readonly CanonicalPath[],
  document: AnimationChamberDocument,
): { source: AssetReference | null; reason?: string } {
  const domains = summarizeStagedDomains(stagedPaths, document).filter(
    (domain) => domain.owner.kind === 'animation-asset',
  );
  if (domains.length === 0) return { source: null, reason: 'No staged change is owned by an animation asset.' };
  if (domains.length > 1) {
    return {
      source: null,
      reason:
        'Staged changes span ' +
        domains.map((domain) => domain.label).join(' and ') +
        '. Each asset is published separately; stage and publish one at a time.',
    };
  }
  const owner = domains[0]!.owner;
  return { source: owner.kind === 'animation-asset' ? owner.reference : null };
}

/**
 * The draft the server seals into the next version.
 *
 * Built from the stored asset plus the session's preview values, so what is
 * published is what the workspace is showing. A variant behaviour is refused:
 * its payload lives in patches against a parent, and writing a resolved graph
 * into it would turn a variant into the full copy the schema exists to make
 * unrepresentable.
 */
export function publicationDraft(input: {
  source: AssetReference;
  animationRegistry: AnimationAssetRegistry;
  preview: AnimationChamberDocument;
}): { draft?: AnimationAsset; reason?: string } {
  const stored = input.animationRegistry.find(input.source);
  if (!stored) {
    return { reason: `${referenceKey(input.source)} is not in this deployment's asset registry.` };
  }
  if (input.source.assetType !== 'animation-behavior') {
    return {
      reason:
        `Publishing ${input.source.assetType} from the animation workspace is not wired yet. ` +
        'The change is staged and visible; nothing was written.',
    };
  }
  const behavior = stored as AnimationBehaviorAsset;
  if (behavior.derivation.mode === 'variant') {
    return {
      reason:
        `${input.source.assetId}@${input.source.version} is a variant. Its payload is patches ` +
        'against a parent, so publishing a resolved graph into it would silently turn it into a ' +
        'full copy. Publish the parent, or author a variant patch.',
    };
  }
  return { draft: { ...behavior, graph: input.preview.graph } as AnimationAsset };
}

/**
 * The live holder set for an asset.
 *
 * Computed from the Prefab registry alone. Scene instances play no part in who
 * *holds* an animation asset — that is a property of a Prefab's own payload —
 * so nothing here needs a project, which is what keeps it Character-free.
 */
export function currentHolders(
  prefabRegistry: PrefabAssetRegistry,
  source: AssetReference,
): GameObjectPrefabReference[] {
  return prefabHoldersOfAnimationAsset(
    describePrefabUsage({ prefabRegistry }),
    source,
  );
}

/**
 * The request, built from exactly what is displayed.
 *
 * `targetPrefabIds` is the selection verbatim — never expanded to "all
 * holders", never defaulted to the current one. `expected` carries the snapshot
 * the human's decision was drawn from, which is what lets the server refuse a
 * repository that moved underneath it.
 */
export function publicationRequest(input: {
  source: AssetReference;
  draft: AnimationAsset;
  holders: readonly GameObjectPrefabReference[];
  selectedPrefabIds: readonly string[];
  projectRevisionId: string;
}): PublishAnimationAndUpdatePrefabsRequest {
  return {
    source: input.source,
    draft: input.draft,
    expected: {
      sourceContentHash: input.source.contentHash,
      projectRevisionId: input.projectRevisionId,
      holderPrefabReferences: [...input.holders],
    },
    targetPrefabIds: [...input.selectedPrefabIds],
  };
}

/** Builds the plan the surface renders and the server re-derives. */
export function publicationPlan(input: {
  prefabRegistry: PrefabAssetRegistry;
  request: PublishAnimationAndUpdatePrefabsRequest;
  projectRevisionId: string;
}): AnimationPublicationPlan {
  return createAnimationPublicationPlan({
    usage: describePrefabUsage({ prefabRegistry: input.prefabRegistry }),
    registry: input.prefabRegistry,
    request: input.request,
    currentProjectRevisionId: input.projectRevisionId,
  });
}

/**
 * Whether what came back is what was asked for.
 *
 * The server derives `changedPrefabIds` from the paths the transaction wrote,
 * never by echoing the request — so comparing them is a real check rather than
 * a tautology, and a mismatch means the write was not the write that was
 * approved.
 */
export function responseMatchesPlan(
  plan: AnimationPublicationPlan,
  changedPrefabIds: readonly string[],
): boolean {
  return changedPrefabIdsEqualTargets(changedPrefabIds, plan.selectedTargets);
}

export const OFFLINE_PUBLICATION_MESSAGE =
  'Preview and staged state remain local. Publication requires the API server. ' +
  'No repository file and no Prefab was changed.';

async function postPublication(
  request: PublishAnimationAndUpdatePrefabsRequest,
): Promise<PublicationResponse> {
  const response = await fetch('/api/animation-assets/publish-and-adopt-prefabs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  return { status: response.status, body: (await response.json()) as PublicationResponse['body'] };
}

/**
 * The subject-scoped publication boundary.
 *
 * State lives here rather than in a component so that "the plan the human
 * approved" survives a re-render and dies with the subject. It is driven by
 * the facade, which owns the one session and the one document it reads.
 */
export class AnimationPublicationController {
  private stage: AnimationPublicationStage = 'closed';
  private selected: string[] = [];
  private result: AnimationPublicationResult | null = null;
  private readonly log: string[] = [];
  private backendOnline: boolean | null = null;
  private readonly listeners = new Set<() => void>();
  private view: AnimationPublicationView;

  constructor(private readonly input: PublicationControllerInput) {
    this.view = this.build();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A stable snapshot, so `useSyncExternalStore` callers do not loop. */
  snapshot(): AnimationPublicationView {
    return this.view;
  }

  private changed(): void {
    this.view = this.build();
    for (const listener of this.listeners) listener();
  }

  private note(message: string): void {
    this.log.push(message);
  }

  private build(): AnimationPublicationView {
    const { session, prefabRegistry, projectRevisionId } = this.input;
    const preview = session.previewProject;
    const staged = session.stagedPaths;
    const domains = summarizeStagedDomains(staged, preview);
    const blocking = blockingFindings(staged, preview);
    const { source } = publicationSource(staged, preview);
    const holders = source ? currentHolders(prefabRegistry, source) : [];

    let plan: AnimationPublicationPlan | null = null;
    if (source && blocking.length === 0 && (this.stage !== 'choosing' || this.selected.length > 0)) {
      const { draft } = publicationDraft({
        source,
        animationRegistry: this.input.animationRegistry,
        preview,
      });
      if (draft) {
        plan = publicationPlan({
          prefabRegistry,
          request: publicationRequest({
            source,
            draft,
            holders,
            selectedPrefabIds: this.selected,
            projectRevisionId,
          }),
          projectRevisionId,
        });
      }
    }

    return {
      stage: this.stage,
      domains,
      blocking,
      source,
      holders,
      selectedPrefabIds: [...this.selected],
      plan,
      result: this.result,
      log: [...this.log],
      backendOnline: this.backendOnline,
    };
  }

  openPublication(): void {
    // Nothing is selected on open. This is the "no default blast radius" rule
    // (§7.4), and it is a state rather than an empty array with a meaning: a
    // zero-target request is only legal from `publish-only`.
    this.stage = 'choosing';
    this.selected = [];
    this.result = null;
    void this.input.backendAvailable().then((online) => {
      this.backendOnline = online;
      if (!online) this.note(OFFLINE_PUBLICATION_MESSAGE);
      this.changed();
    });
    this.changed();
  }

  closePublication(): void {
    this.stage = 'closed';
    this.changed();
  }

  togglePublicationTarget(prefabId: string): void {
    this.selected = this.selected.includes(prefabId)
      ? this.selected.filter((id) => id !== prefabId)
      : [...this.selected, prefabId].sort();
    // Deselecting the last target returns to "choosing", not to publish-only:
    // those are different decisions and must not be reachable by accident.
    this.stage = this.selected.length > 0 ? 'targets-chosen' : 'choosing';
    this.changed();
  }

  choosePublishOnly(): void {
    this.selected = [];
    this.stage = 'publish-only';
    this.changed();
  }

  async submitPublication(intent: string): Promise<void> {
    const view = this.build();
    if (this.stage !== 'publish-only' && this.stage !== 'targets-chosen') {
      this.note('Choose a destination first. Publication never picks one for you.');
      this.changed();
      return;
    }
    if (view.blocking.length > 0) {
      this.note(
        `Refused: ${view.blocking.length} staged path(s) have no exact owner. Nothing was written.`,
      );
      this.stage = 'refused';
      this.changed();
      return;
    }
    if (!view.source) {
      this.note('Refused: no single animation asset owns the staged changes. Nothing was written.');
      this.stage = 'refused';
      this.changed();
      return;
    }

    const { draft, reason } = publicationDraft({
      source: view.source,
      animationRegistry: this.input.animationRegistry,
      preview: this.input.session.previewProject,
    });
    if (!draft) {
      this.note(`Refused: ${reason} Nothing was written.`);
      this.stage = 'refused';
      this.changed();
      return;
    }

    const online = await this.input.backendAvailable();
    this.backendOnline = online;
    if (!online) {
      // Not "the write failed" — no write was attempted, and saying otherwise
      // would leave a human believing the repository moved (§7.7).
      this.note(OFFLINE_PUBLICATION_MESSAGE);
      this.stage = 'refused';
      this.changed();
      return;
    }

    const request = publicationRequest({
      source: view.source,
      draft,
      holders: view.holders,
      selectedPrefabIds: this.selected,
      projectRevisionId: this.input.projectRevisionId,
    });
    const plan = publicationPlan({
      prefabRegistry: this.input.prefabRegistry,
      request,
      projectRevisionId: this.input.projectRevisionId,
    });
    if (plan.conflicts.length > 0) {
      this.result = {
        ok: false,
        changedPrefabIds: [],
        publishedPrefabs: [],
        conflicts: plan.conflicts.map((conflict) => ({
          code: conflict.code,
          message: conflict.message,
        })),
      };
      this.note(`Refused before sending: ${plan.conflicts.length} conflict(s). Nothing was written.`);
      this.stage = 'refused';
      this.changed();
      return;
    }
    if (plan.protectedTargets.length > 0) {
      this.result = {
        ok: false,
        changedPrefabIds: [],
        publishedPrefabs: [],
        conflicts: plan.protectedTargets.map((target) => ({
          code: 'protected',
          message: `${target.assetId}@${target.version} is protected and cannot adopt.`,
        })),
      };
      this.note('Refused: a selected target is protected. Nothing was written.');
      this.stage = 'refused';
      this.changed();
      return;
    }

    this.stage = 'submitting';
    this.note(`Submitting: ${intent || '(no intent recorded)'}`);
    this.changed();

    const send = this.input.submit ?? postPublication;
    let response: PublicationResponse;
    try {
      response = await send(request);
    } catch (error) {
      this.result = {
        ok: false,
        changedPrefabIds: [],
        publishedPrefabs: [],
        conflicts: [
          { code: 'transport', message: error instanceof Error ? error.message : String(error) },
        ],
      };
      this.note('The request did not reach the server. Nothing was written.');
      this.stage = 'refused';
      this.changed();
      return;
    }

    const changedPrefabIds = response.body.changedTargets?.prefabIds ?? [];
    if (response.body.ok !== true) {
      this.result = {
        ok: false,
        changedPrefabIds,
        publishedPrefabs: [],
        conflicts: (response.body.issues ?? []).map((issue) => ({
          code: issue.keyword ?? 'refused',
          message: issue.message,
        })),
      };
      this.note(`Refused by the server (${response.status}). Nothing was written.`);
      this.stage = 'refused';
      this.changed();
      return;
    }

    if (!responseMatchesPlan(plan, changedPrefabIds)) {
      /*
       * The write succeeded but is not the write that was approved. Reporting
       * it as success would be the exact failure the plan equality exists to
       * catch, so it is surfaced as a conflict even though the status was 200.
       */
      this.result = {
        ok: false,
        changedPrefabIds,
        publishedPrefabs: response.body.published?.prefabs ?? [],
        conflicts: [
          {
            code: 'target-mismatch',
            message:
              `the server changed [${changedPrefabIds.join(', ') || 'nothing'}] but the approved ` +
              `plan named [${plan.selectedTargets.map((target) => target.assetId).join(', ') || 'nothing'}]`,
          },
        ],
      };
      this.stage = 'refused';
      this.changed();
      return;
    }

    this.result = {
      ok: true,
      changedPrefabIds,
      ...(response.body.published?.animation ? { publishedAnimation: response.body.published.animation } : {}),
      publishedPrefabs: response.body.published?.prefabs ?? [],
      conflicts: [],
    };
    this.note(
      `Published ${response.body.published?.animation?.assetId ?? view.source.assetId}` +
        `@${response.body.published?.animation?.version ?? '?'}; ` +
        `${changedPrefabIds.length} Prefab(s) adopted it.`,
    );
    // The route does not move. A session that jumped to the new version would
    // discard unrelated local edits and change what the URL identifies without
    // being asked (§8.2).
    this.stage = 'published';
    this.changed();
  }
}
