import { describe, expect, it } from 'vitest';
import { RuleBasedProvider, createAiProvider, parseIntent } from '@atc/ai-adapter';
import { analyzeDiff, getAtPath, setAtPath } from '@atc/runtime-core';
import { loadDemoProject } from '../fixtures/project.ts';

const project = loadDemoProject();
const provider = new RuleBasedProvider();
const TARGET = '/graph/transitions/run-to-attack-01';

describe('provider selection', () => {
  it('falls back to the rule-based provider with no API key', () => {
    expect(createAiProvider({}).id).toBe('rule-based');
    expect(createAiProvider({ AI_PROVIDER: 'anthropic' }).id).toBe('rule-based');
    expect(createAiProvider({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'x' }).id).toBe(
      'anthropic',
    );
  });

  it('does not require an API key for the fallback', () => {
    expect(createAiProvider({}).requiresApiKey).toBe(false);
  });
});

describe('intent parsing', () => {
  it('reads Japanese and English phrasings of the same request', () => {
    const japanese = parseIntent('攻撃の初動を速くし、重量感は残す');
    const english = parseIntent('make the attack start faster but keep the weight');
    expect(japanese.responsiveness).toBeGreaterThan(0);
    expect(japanese.weight).toBeGreaterThan(0);
    expect(english.responsiveness).toBeGreaterThan(0);
    expect(english.weight).toBeGreaterThan(0);
  });

  it('reads opposing adjectives in opposite directions', () => {
    expect(parseIntent('slower').responsiveness).toBeLessThan(0);
    expect(parseIntent('lighter, more floaty').weight).toBeLessThan(0);
  });
});

describe('proposals', () => {
  it('always returns exactly three labelled variants', async () => {
    const proposals = await provider.proposeAdjustments({
      project,
      request: '攻撃の初動を速くし、重量感は残す',
      targetPath: TARGET,
    });
    expect(proposals).toHaveLength(3);
    expect(proposals.map((p) => p.variant)).toEqual([
      'A-responsive',
      'B-weighted',
      'C-preserve-original',
    ]);
  });

  it('is deterministic: the same request twice gives identical output', async () => {
    const request = 'make it snappier without losing weight';
    const first = await provider.proposeAdjustments({ project, request, targetPath: TARGET });
    const second = await provider.proposeAdjustments({ project, request, targetPath: TARGET });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('never proposes a change to a locked field', async () => {
    const proposals = await provider.proposeAdjustments({
      project,
      request: '重量感を強くして、もっと前に踏み込む',
      targetPath: TARGET,
    });
    const lockedPath = `${TARGET}/momentumRetention`;
    for (const proposal of proposals) {
      expect(proposal.changes.map((change) => change.path)).not.toContain(lockedPath);
      expect(proposal.protectedFieldsRespected).toContain(lockedPath);
    }
  });

  it('flags approval when the target is approval-required', async () => {
    const proposals = await provider.proposeAdjustments({
      project,
      request: 'faster',
      targetPath: TARGET,
    });
    expect(proposals.every((proposal) => proposal.requiresApproval)).toBe(true);
  });

  it('does not require approval for an unprotected transition', async () => {
    const proposals = await provider.proposeAdjustments({
      project,
      request: 'faster',
      targetPath: '/graph/transitions/idle-to-walk',
    });
    expect(proposals.every((proposal) => proposal.requiresApproval)).toBe(false);
  });

  it('translates "faster but keep the weight" without touching playback speed', async () => {
    const proposals = await provider.proposeAdjustments({
      project,
      request: '攻撃の初動を速くし、重量感は残す',
      targetPath: TARGET,
    });
    const changedFields = proposals.flatMap((proposal) =>
      proposal.changes.map((change) => change.path.split('/').pop()),
    );
    // The blunt instrument stays in the drawer.
    expect(changedFields).not.toContain('playbackSpeed');
    // The subtle ones are what move.
    expect(changedFields).toContain('inputBufferMs');
    expect(changedFields).toContain('blendDurationSec');
  });

  it('keeps blend durations inside the project preference range', async () => {
    const proposals = await provider.proposeAdjustments({
      project,
      request: 'much much faster, extremely snappy',
      targetPath: TARGET,
    });
    for (const proposal of proposals) {
      const blend = proposal.changes.find((change) => change.path.endsWith('blendDurationSec'));
      if (!blend) continue;
      expect(blend.after as number).toBeGreaterThanOrEqual(project.preferences.preferredBlendMinSec);
      expect(blend.after as number).toBeLessThanOrEqual(project.preferences.preferredBlendMaxSec);
    }
  });

  it('produces three genuinely different variants, not three copies', async () => {
    const proposals = await provider.proposeAdjustments({
      project,
      request: 'faster startup',
      targetPath: TARGET,
    });
    const signatures = proposals.map((proposal) =>
      proposal.changes.map((change) => `${change.path}=${String(change.after)}`).join(','),
    );
    expect(new Set(signatures).size).toBe(3);
  });

  it('names the replays a change is likely to affect', async () => {
    const proposals = await provider.proposeAdjustments({
      project,
      request: 'faster',
      targetPath: TARGET,
    });
    expect(proposals[0]!.testImpact).toContain('run-to-attack-forward');
  });
});

describe('harmonization', () => {
  it('nudges sibling transitions toward the tuned value without flattening them', async () => {
    const tuned = setAtPath(project, `${TARGET}/blendDurationSec`, 0.05);
    const patch = await provider.harmonizeRelatedTransitions({
      project: tuned,
      request: '',
      targetPath: TARGET,
    });
    // idle-to-attack-01 also enters attack-01.
    const sibling = patch.changes.find((change) => change.path.includes('idle-to-attack-01'));
    expect(sibling).toBeDefined();
    const before = getAtPath(tuned, sibling!.path) as number;
    expect(sibling!.after as number).toBeLessThan(before);
    expect(sibling!.after as number).toBeGreaterThan(0.05);
  });
});

describe('regression review', () => {
  it('demands a human decision when protected behaviour changed', async () => {
    const review = await provider.reviewRegression({
      replayId: 'run-to-attack-forward',
      differences: [],
      protectedBehaviorChanged: true,
    });
    expect(review.requiresHumanDecision).toBe(true);
    expect(review.verdict).toBe('needs-human');
  });

  it('treats a changed state sequence as a likely regression', async () => {
    const review = await provider.reviewRegression({
      replayId: 'run-to-attack-forward',
      differences: [{ kind: 'state-sequence', message: 'changed', expected: 'a', actual: 'b' }],
      protectedBehaviorChanged: false,
    });
    expect(review.verdict).toBe('likely-regression');
    expect(review.requiresHumanDecision).toBe(true);
  });

  it('accepts an unchanged run without asking anyone', async () => {
    const review = await provider.reviewRegression({
      replayId: 'x',
      differences: [],
      protectedBehaviorChanged: false,
    });
    expect(review.requiresHumanDecision).toBe(false);
  });
});

describe('diff explanation', () => {
  it('summarises changes and surfaces blocked ones', async () => {
    const edited = setAtPath(project, '/graph/transitions/idle-to-walk/blendDurationSec', 0.3);
    const explanation = await provider.explainDiff(analyzeDiff(project, edited));
    expect(explanation.summary).toContain('1 change');
    expect(explanation.details.join(' ')).toContain('increased');
  });
});
