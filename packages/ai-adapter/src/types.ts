import type { AnimationGraphDefinition, PreferenceProfile } from '@atc/schema';
import type { CanonicalPath, DiffReport } from '@atc/runtime-core';

/**
 * The document a proposal is computed against.
 *
 * This used to be `ResolvedProject`, which carried `characters` and
 * `activeCharacterId` into every call site. The native animation workspace
 * edits an exact Prefab Animator and has no Character to offer, and handing the
 * provider a Character-shaped object purely to satisfy a type is the one
 * compatibility shortcut the restoration forbids.
 *
 * So the parameter names what the providers actually read: the graph they tune
 * and the blend preferences that bound the result. Protection is read through
 * `canAiPropose`/`requiresHumanApproval`, which take an `unknown` root and walk
 * the path — they never needed a project either.
 *
 * `ResolvedProject` still satisfies this structurally, so the legacy callers
 * are unchanged; what changes is that a Character-free document now satisfies
 * it too.
 */
export interface TunableAnimationDocument {
  graph: AnimationGraphDefinition;
  preferences: PreferenceProfile;
}

/** The three variants a proposal set always offers (PLAN 14.2). */
export type ProposalVariant = 'A-responsive' | 'B-weighted' | 'C-preserve-original';

export interface ProposedChange {
  path: CanonicalPath;
  before: unknown;
  after: unknown;
  /** Why this specific field moved, in one line. */
  reason: string;
}

export interface AdjustmentProposal {
  variant: ProposalVariant;
  title: string;
  changes: ProposedChange[];
  rationale: string;
  expectedTradeoffs: string[];
  /** Paths the request would have touched but protection forbade. */
  protectedFieldsRespected: CanonicalPath[];
  /** True when applying this needs explicit human sign-off. */
  requiresApproval: boolean;
  /** Replays whose expectations this proposal is likely to move. */
  testImpact: string[];
}

export interface ProposalContext {
  project: TunableAnimationDocument;
  /** Natural-language request from the human, in any language. */
  request: string;
  /** Path of the object being tuned, e.g. /graph/transitions/run-to-attack-01 */
  targetPath: CanonicalPath;
  replayId?: string;
  terrainPresetId?: string;
}

export interface Explanation {
  summary: string;
  details: string[];
}

export interface PatchSet {
  changes: ProposedChange[];
  rationale: string;
  protectedFieldsRespected: CanonicalPath[];
}

export interface RegressionReport {
  replayId: string;
  differences: { kind: string; message: string; expected: string; actual: string }[];
  protectedBehaviorChanged: boolean;
}

export interface Review {
  verdict: 'looks-intentional' | 'likely-regression' | 'needs-human';
  reasoning: string;
  requiresHumanDecision: boolean;
}

/**
 * The seam every AI provider implements. Nothing in the app depends on a
 * specific vendor, and the rule-based implementation satisfies the same
 * contract, so the chamber is fully usable with no API key configured.
 */
export interface AiProvider {
  readonly id: string;
  readonly requiresApiKey: boolean;
  proposeAdjustments(context: ProposalContext): Promise<AdjustmentProposal[]>;
  explainDiff(diff: DiffReport): Promise<Explanation>;
  harmonizeRelatedTransitions(context: ProposalContext): Promise<PatchSet>;
  reviewRegression(report: RegressionReport): Promise<Review>;
}
