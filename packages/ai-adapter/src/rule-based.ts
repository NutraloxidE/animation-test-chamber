import type { ResolvedProject, TransitionDefinition } from '@atc/schema';
import {
  canAiEdit,
  canAiPropose,
  clamp,
  getAtPath,
  requiresHumanApproval,
  type CanonicalPath,
  type DiffReport,
} from '@atc/runtime-core';
import type {
  AdjustmentProposal,
  AiProvider,
  Explanation,
  PatchSet,
  ProposalContext,
  ProposalVariant,
  ProposedChange,
  RegressionReport,
  Review,
} from './types.ts';

/**
 * Intent extracted from a natural-language request. Each axis is -1..1, where
 * positive means "more of this". Both Japanese and English phrasings are
 * recognized because the request box accepts either.
 */
interface Intent {
  responsiveness: number;
  weight: number;
  smoothness: number;
  reach: number;
  matched: string[];
}

const KEYWORDS: { pattern: RegExp; apply: (intent: Intent) => void; label: string }[] = [
  {
    pattern: /(faster|quicker|snappy|responsive|速く|早く|速い|素早|機敏|レスポンス)/i,
    apply: (i) => {
      i.responsiveness += 1;
    },
    label: 'faster startup',
  },
  {
    pattern: /(slower|delayed|遅く|ゆっくり|溜め)/i,
    apply: (i) => {
      i.responsiveness -= 1;
    },
    label: 'slower startup',
  },
  {
    pattern: /(weight|weighty|heavy|impact|重量感|重み|重い|重厚|手応え)/i,
    apply: (i) => {
      i.weight += 1;
    },
    label: 'preserve weight',
  },
  {
    pattern: /(light|floaty|軽く|軽い|軽快)/i,
    apply: (i) => {
      i.weight -= 1;
    },
    label: 'lighter feel',
  },
  {
    pattern: /(smooth|soft|gentle|滑らか|柔らか|なめらか|自然)/i,
    apply: (i) => {
      i.smoothness += 1;
    },
    label: 'smoother blend',
  },
  {
    pattern: /(sharp|crisp|hard|硬い|鋭い|キビキビ|パキッ)/i,
    apply: (i) => {
      i.smoothness -= 1;
    },
    label: 'sharper blend',
  },
  {
    pattern: /(further|distance|reach|前進|踏み込|飛距離|移動距離)/i,
    apply: (i) => {
      i.reach += 1;
    },
    label: 'more forward reach',
  },
];

export function parseIntent(request: string): Intent {
  const intent: Intent = { responsiveness: 0, weight: 0, smoothness: 0, reach: 0, matched: [] };
  for (const keyword of KEYWORDS) {
    if (keyword.pattern.test(request)) {
      keyword.apply(intent);
      intent.matched.push(keyword.label);
    }
  }
  return intent;
}

interface FieldRule {
  field: keyof TransitionDefinition;
  min: number;
  max: number;
  /** Change per unit of intent, per variant strength. */
  compute: (current: number, intent: Intent, strength: number, project: ResolvedProject) => number;
  reason: string;
}

/**
 * The translation table from PLAN 14.3. "Faster startup without losing weight"
 * must not become "raise playback speed" — it becomes earlier input acceptance,
 * a shorter blend and a small start offset, while the body speed and momentum
 * stay put.
 */
const TRANSITION_RULES: FieldRule[] = [
  {
    field: 'inputBufferMs',
    min: 0,
    max: 1000,
    compute: (current, intent, strength) => current + intent.responsiveness * 45 * strength,
    reason: 'accept the input earlier without changing the motion itself',
  },
  {
    field: 'blendDurationSec',
    min: 0,
    max: 2,
    compute: (current, intent, strength, project) => {
      const shortened = current - intent.responsiveness * 0.035 * strength;
      const smoothed = shortened + intent.smoothness * 0.03 * strength;
      // Stay inside the blend range this project has settled on.
      return clamp(
        smoothed,
        project.preferences.preferredBlendMinSec,
        project.preferences.preferredBlendMaxSec,
      );
    },
    reason: 'shorten the crossfade so the action reads sooner',
  },
  {
    field: 'startOffsetNormalized',
    min: 0,
    max: 1,
    compute: (current, intent, strength) =>
      current + intent.responsiveness * 0.02 * strength - intent.weight * 0.01 * strength,
    reason: 'skip a little of the windup instead of speeding the whole clip up',
  },
  {
    field: 'momentumRetention',
    min: 0,
    max: 1,
    compute: (current, intent, strength) =>
      current + intent.weight * 0.08 * strength + intent.reach * 0.05 * strength,
    reason: 'carry existing velocity through the transition to keep the weight',
  },
  {
    field: 'playbackSpeed',
    min: 0.05,
    max: 4,
    compute: (current, intent, strength) => {
      // Only touch clip speed when the request explicitly wants lightness; it is
      // the blunt instrument that destroys the sense of weight.
      if (intent.weight >= 0) return current;
      return current + intent.responsiveness * 0.06 * strength;
    },
    reason: 'slightly faster playback, only because a lighter feel was requested',
  },
];

const VARIANTS: { variant: ProposalVariant; title: string; strength: number; bias: Partial<Intent> }[] =
  [
    {
      variant: 'A-responsive',
      title: 'A — Responsive',
      strength: 1.4,
      bias: { responsiveness: 0.4 },
    },
    { variant: 'B-weighted', title: 'B — Weighted', strength: 0.7, bias: { weight: 0.5 } },
    { variant: 'C-preserve-original', title: 'C — Preserve original', strength: 0.25, bias: {} },
  ];

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

const DECIMALS: Partial<Record<string, number>> = {
  blendDurationSec: 3,
  startOffsetNormalized: 3,
  momentumRetention: 3,
  playbackSpeed: 3,
  inputBufferMs: 0,
};

/**
 * Deterministic tuning provider used whenever no external AI key is configured.
 *
 * It is not a stub: it produces three genuinely different, protection-aware
 * proposals from the same request, and running it twice on the same input gives
 * byte-identical output, which is what makes A/B/C comparison meaningful.
 */
export class RuleBasedProvider implements AiProvider {
  readonly id = 'rule-based';
  readonly requiresApiKey = false;

  async proposeAdjustments(context: ProposalContext): Promise<AdjustmentProposal[]> {
    const baseIntent = parseIntent(context.request);
    const target = getAtPath(context.project, context.targetPath);

    if (!target || typeof target !== 'object') {
      return [];
    }

    return VARIANTS.map(({ variant, title, strength, bias }) => {
      const intent: Intent = {
        responsiveness: baseIntent.responsiveness + (bias.responsiveness ?? 0),
        weight: baseIntent.weight + (bias.weight ?? 0),
        smoothness: baseIntent.smoothness + (bias.smoothness ?? 0),
        reach: baseIntent.reach + (bias.reach ?? 0),
        matched: baseIntent.matched,
      };

      const changes: ProposedChange[] = [];
      const protectedFields: CanonicalPath[] = [];
      let needsApproval = false;

      for (const rule of TRANSITION_RULES) {
        const path = `${context.targetPath}/${String(rule.field)}`;
        const current = getAtPath(context.project, path);
        if (typeof current !== 'number') continue;

        // Locked and invariant fields are not even suggested. Approval-required
        // fields may be proposed, and the proposal is marked accordingly.
        if (!canAiPropose(context.project, path)) {
          protectedFields.push(path);
          continue;
        }
        if (requiresHumanApproval(context.project, path)) needsApproval = true;

        const raw = rule.compute(current, intent, strength, context.project);
        const next = round(clamp(raw, rule.min, rule.max), DECIMALS[String(rule.field)] ?? 3);
        if (next === current) continue;

        changes.push({ path, before: current, after: next, reason: rule.reason });
      }

      return {
        variant,
        title,
        changes,
        rationale: buildRationale(variant, intent, changes.length),
        expectedTradeoffs: buildTradeoffs(variant, intent),
        protectedFieldsRespected: protectedFields,
        // Sign-off is needed when the object itself, or any field this proposal
        // actually touches, is under approval-required protection.
        requiresApproval: needsApproval || requiresApproval(context.project, context.targetPath),
        testImpact: testImpactFor(context),
      };
    });
  }

  async explainDiff(diff: DiffReport): Promise<Explanation> {
    const details = diff.changes.map((change) => {
      const direction =
        typeof change.before === 'number' && typeof change.after === 'number'
          ? change.after > change.before
            ? 'increased'
            : 'decreased'
          : 'changed';
      return `${change.path} ${direction} (${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)})`;
    });

    const blocking = diff.findings.filter((finding) => finding.severity === 'blocking');
    const summary =
      blocking.length > 0
        ? `${diff.changes.length} change(s), ${blocking.length} of which are blocked by protection policy.`
        : `${diff.changes.length} change(s), none blocked by protection policy.`;

    return { summary, details: [...details, ...diff.findings.map((f) => `[${f.severity}] ${f.path}: ${f.message}`)] };
  }

  /**
   * Suggests matching adjustments on sibling transitions so a single tuned
   * transition does not leave the rest of the graph inconsistent.
   */
  async harmonizeRelatedTransitions(context: ProposalContext): Promise<PatchSet> {
    const changes: ProposedChange[] = [];
    const protectedFields: CanonicalPath[] = [];

    const targetId = context.targetPath.split('/').pop() ?? '';
    const target = context.project.graph.transitions.find((t) => t.id === targetId);
    if (!target) return { changes, rationale: 'target transition not found', protectedFieldsRespected: [] };

    // Related = transitions into the same destination state. Those are what the
    // player perceives as "the same move" arriving from different situations.
    const related = context.project.graph.transitions.filter(
      (candidate) => candidate.to === target.to && candidate.id !== target.id,
    );

    for (const transition of related) {
      const path = `/graph/transitions/${transition.id}/blendDurationSec`;
      if (!canAiEdit(context.project, path)) {
        protectedFields.push(path);
        continue;
      }
      // Move siblings a third of the way toward the tuned value rather than
      // flattening them all to the same number.
      const next = round(
        transition.blendDurationSec + (target.blendDurationSec - transition.blendDurationSec) / 3,
        3,
      );
      if (next !== transition.blendDurationSec) {
        changes.push({
          path,
          before: transition.blendDurationSec,
          after: next,
          reason: `move a third of the way toward ${target.id}'s blend for consistency`,
        });
      }
    }

    return {
      changes,
      rationale: `${related.length} transition(s) also enter "${target.to}"; nudged toward the tuned value without flattening the differences between them.`,
      protectedFieldsRespected: protectedFields,
    };
  }

  async reviewRegression(report: RegressionReport): Promise<Review> {
    if (report.protectedBehaviorChanged) {
      return {
        verdict: 'needs-human',
        reasoning:
          'A behaviour under protection changed. This is never auto-accepted: a human must accept or reject it.',
        requiresHumanDecision: true,
      };
    }
    const stateChanged = report.differences.some((d) => d.kind === 'state-sequence');
    if (stateChanged) {
      return {
        verdict: 'likely-regression',
        reasoning:
          'The state sequence itself changed, which usually means a transition now fires at a different time rather than the motion merely looking different.',
        requiresHumanDecision: true,
      };
    }
    if (report.differences.length === 0) {
      return {
        verdict: 'looks-intentional',
        reasoning: 'No differences beyond tolerance.',
        requiresHumanDecision: false,
      };
    }
    return {
      verdict: 'looks-intentional',
      reasoning: `${report.differences.length} difference(s), all within metric categories rather than state changes.`,
      requiresHumanDecision: false,
    };
  }
}

function requiresApproval(project: ResolvedProject, targetPath: CanonicalPath): boolean {
  const target = getAtPath(project, targetPath);
  const protection = (target as { protection?: { level?: string } } | undefined)?.protection;
  return protection?.level === 'approval-required';
}

function buildRationale(variant: ProposalVariant, intent: Intent, changeCount: number): string {
  const heard = intent.matched.length > 0 ? intent.matched.join(', ') : 'no specific adjective';
  switch (variant) {
    case 'A-responsive':
      return `Read as: ${heard}. Prioritises how soon the input registers — earlier buffer, shorter blend, small start offset — across ${changeCount} field(s). The clip's own speed is left alone.`;
    case 'B-weighted':
      return `Read as: ${heard}. Applies the same direction more conservatively and leans on momentum retention, so the move still lands with mass. ${changeCount} field(s) changed.`;
    case 'C-preserve-original':
      return `Read as: ${heard}. Deliberately minimal: the smallest nudge that is still perceptible, for comparing against doing nothing. ${changeCount} field(s) changed.`;
  }
}

function buildTradeoffs(variant: ProposalVariant, intent: Intent): string[] {
  const tradeoffs: string[] = [];
  if (variant === 'A-responsive') {
    tradeoffs.push('The transition may read as abrupt on slower clips.');
    tradeoffs.push('A wider input buffer can make queued inputs feel like they fire late.');
  }
  if (variant === 'B-weighted') {
    tradeoffs.push('Less improvement in perceived responsiveness than A.');
    tradeoffs.push('Higher momentum retention can overshoot on ice and other low-friction surfaces.');
  }
  if (variant === 'C-preserve-original') {
    tradeoffs.push('The change may be below the threshold of perception.');
  }
  if (intent.responsiveness > 0 && intent.weight > 0) {
    tradeoffs.push(
      'Faster startup and preserved weight pull against each other; the start offset is the compromise being spent here.',
    );
  }
  return tradeoffs;
}

function testImpactFor(context: ProposalContext): string[] {
  const impacted: string[] = [];
  const targetId = context.targetPath.split('/').pop() ?? '';
  if (targetId.includes('attack')) {
    impacted.push('run-to-attack-forward', 'attack-01-to-attack-02', 'late-dodge-cancel');
  }
  if (targetId.includes('jump')) impacted.push('jump-buffer-before-landing', 'moving-platform-jump');
  if (targetId.includes('dodge')) impacted.push('late-dodge-cancel');
  if (context.replayId && !impacted.includes(context.replayId)) impacted.push(context.replayId);
  return impacted;
}
