import type { ProjectDefinition } from '@atc/schema';
import type { CanonicalPath, DiffReport } from '@atc/runtime-core';

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
  project: ProjectDefinition;
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
