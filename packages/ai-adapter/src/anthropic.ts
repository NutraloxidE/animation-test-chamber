import { canAiPropose, getAtPath, type CanonicalPath, type DiffReport } from '@atc/runtime-core';
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
import { RuleBasedProvider } from './rule-based.ts';

const VARIANT_ORDER: ProposalVariant[] = ['A-responsive', 'B-weighted', 'C-preserve-original'];

interface ModelProposal {
  variant?: string;
  title?: string;
  changes?: { path?: string; after?: unknown; reason?: string }[];
  rationale?: string;
  expectedTradeoffs?: string[];
}

/**
 * Optional provider backed by the Anthropic Messages API.
 *
 * Two rules govern this class:
 *  1. It is never required. Every method falls back to the deterministic
 *     rule-based provider when the key is absent or the call fails.
 *  2. Model output is never trusted with protection. Whatever the model
 *     returns, every proposed path is re-checked against the protection gate
 *     here, and protected paths are dropped rather than applied.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic';
  readonly requiresApiKey = true;

  private readonly fallback = new RuleBasedProvider();

  constructor(
    private readonly apiKey: string,
    private readonly model = 'claude-opus-5',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async complete(system: string, user: string): Promise<string | null> {
    try {
      const response = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2048,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { content?: { type: string; text?: string }[] };
      const text = payload.content?.find((block) => block.type === 'text')?.text;
      return text ?? null;
    } catch {
      return null;
    }
  }

  async proposeAdjustments(context: ProposalContext): Promise<AdjustmentProposal[]> {
    const target = getAtPath(context.project, context.targetPath);
    if (!target || typeof target !== 'object') return [];

    // Only offer the model fields it is actually allowed to change.
    const editableFields = Object.entries(target as Record<string, unknown>)
      .filter(
        ([key, value]) =>
          typeof value === 'number' && canAiPropose(context.project, `${context.targetPath}/${key}`),
      )
      .map(([key, value]) => `${key} = ${String(value)}`);

    if (editableFields.length === 0) return this.fallback.proposeAdjustments(context);

    const system = [
      'You tune character animation transitions for a game.',
      'Return ONLY JSON: an array of exactly 3 objects with keys',
      '"variant" (one of A-responsive, B-weighted, C-preserve-original), "title",',
      '"changes" (array of {path, after, reason}), "rationale", "expectedTradeoffs" (array of strings).',
      'Never raise playback speed to make something feel faster unless lightness was requested;',
      'prefer input buffer, blend duration and start offset. Keep changes inside the field ranges.',
    ].join('\n');

    const user = [
      `Request: ${context.request}`,
      `Target: ${context.targetPath}`,
      'Editable fields (name = current value):',
      ...editableFields.map((field) => `  ${field}`),
      `Project blend preference: ${context.project.preferences.preferredBlendMinSec}..${context.project.preferences.preferredBlendMaxSec} seconds`,
      'Paths in "changes" must be the full canonical path, e.g. ' + `${context.targetPath}/blendDurationSec`,
    ].join('\n');

    const text = await this.complete(system, user);
    if (!text) return this.fallback.proposeAdjustments(context);

    const parsed = parseJsonArray(text);
    if (!parsed) return this.fallback.proposeAdjustments(context);

    const proposals = parsed.map((raw, index) =>
      this.toProposal(raw, context, VARIANT_ORDER[index] ?? 'C-preserve-original'),
    );

    // If the model produced nothing usable after protection filtering, the
    // deterministic provider is a better answer than three empty proposals.
    return proposals.some((proposal) => proposal.changes.length > 0)
      ? proposals
      : this.fallback.proposeAdjustments(context);
  }

  private toProposal(
    raw: ModelProposal,
    context: ProposalContext,
    fallbackVariant: ProposalVariant,
  ): AdjustmentProposal {
    const changes: ProposedChange[] = [];
    const protectedFields: CanonicalPath[] = [];

    for (const change of raw.changes ?? []) {
      const path = change.path;
      if (typeof path !== 'string' || !path.startsWith(context.targetPath)) continue;

      const before = getAtPath(context.project, path);
      if (typeof before !== 'number' || typeof change.after !== 'number') continue;

      // The protection gate is re-applied here regardless of what the model said.
      if (!canAiPropose(context.project, path)) {
        protectedFields.push(path);
        continue;
      }
      if (change.after === before) continue;

      changes.push({
        path,
        before,
        after: change.after,
        reason: change.reason ?? 'proposed by the model',
      });
    }

    const variant = VARIANT_ORDER.includes(raw.variant as ProposalVariant)
      ? (raw.variant as ProposalVariant)
      : fallbackVariant;

    const targetProtection = (
      getAtPath(context.project, context.targetPath) as { protection?: { level?: string } } | undefined
    )?.protection;

    return {
      variant,
      title: raw.title ?? variant,
      changes,
      rationale: raw.rationale ?? '',
      expectedTradeoffs: Array.isArray(raw.expectedTradeoffs) ? raw.expectedTradeoffs : [],
      protectedFieldsRespected: protectedFields,
      requiresApproval: targetProtection?.level === 'approval-required',
      testImpact: [],
    };
  }

  async explainDiff(diff: DiffReport): Promise<Explanation> {
    return this.fallback.explainDiff(diff);
  }

  async harmonizeRelatedTransitions(context: ProposalContext): Promise<PatchSet> {
    return this.fallback.harmonizeRelatedTransitions(context);
  }

  async reviewRegression(report: RegressionReport): Promise<Review> {
    return this.fallback.reviewRegression(report);
  }
}

function parseJsonArray(text: string): ModelProposal[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as ModelProposal[]) : null;
  } catch {
    return null;
  }
}
