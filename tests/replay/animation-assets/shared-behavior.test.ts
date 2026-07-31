import { describe, expect, it } from 'vitest';
import { REPLAY_FIXTURES, runReplay } from '@atc/replay-runtime';
import { clipIdForState, motionResolverFor } from '@atc/animation-runtime';
import { loadDemoProject, loadResolvedDemoProject } from '../../fixtures/project.ts';
import {
  compareAgainstLegacy,
  compareSharedBehaviorSequences,
  summarizeTrace,
} from '../../../harness/shadow-compare.ts';

const project = loadDemoProject();
const [first, second] = project.characters;

describe('migration preserves behaviour', () => {
  /**
   * The oracle is the runtime as it stood before the asset split, captured at
   * that commit. Every name-based branch that became a policy field is checked
   * here at once: if any of them stopped reproducing the old rule, the trace
   * hash moves.
   */
  it('reproduces the pre-migration traces exactly', () => {
    expect(compareAgainstLegacy()).toEqual([]);
  });

  it('reproduces them for the second character too', () => {
    // Same behaviour, different clips: the sequencing must still be the old one.
    const differences = compareAgainstLegacy(second!.id).filter(
      (difference) => difference.field === 'locomotionSequence' || difference.field === 'actionSequence',
    );
    expect(differences).toEqual([]);
  });
});

describe('two characters, one behaviour', () => {
  it('the project ships two characters on the same behaviour asset', () => {
    expect(project.characters.length).toBeGreaterThanOrEqual(2);
    expect(first!.animation.behavior.assetId).toBe(second!.animation.behavior.assetId);
  });

  it('they run different motion sets', () => {
    expect(first!.animation.motionSet.assetId).not.toBe(second!.animation.motionSet.assetId);
  });

  it('state and transition sequences match, and only the clips differ', () => {
    expect(compareSharedBehaviorSequences(first!.id, second!.id)).toEqual([]);
  });

  it('no motion slot resolves to the same clip in both characters', () => {
    const a = loadResolvedDemoProject(first!.id);
    const b = loadResolvedDemoProject(second!.id);
    for (const [slot, clipId] of Object.entries(a.motionBindings)) {
      expect(b.motionBindings[slot]).not.toBe(clipId);
    }
  });

  it.each(['idle', 'walk', 'run', 'jump', 'attack-01', 'dodge'])(
    'the %s state plays a different clip for each character',
    (stateId) => {
      const a = loadResolvedDemoProject(first!.id);
      const b = loadResolvedDemoProject(second!.id);
      const clipA = clipIdForState(a, stateId);
      const clipB = clipIdForState(b, stateId);
      expect(clipA).toBeDefined();
      expect(clipB).toBeDefined();
      expect(clipA).not.toBe(clipB);
    },
  );

  it('the second character has its own tuning profile', () => {
    expect(second!.animation.tuning?.assetId).not.toBe(first!.animation.tuning?.assetId);
  });

  it('the shared behaviour is one asset, not two copies', () => {
    expect(first!.animation.behavior.contentHash).toBe(second!.animation.behavior.contentHash);
  });
});

describe('motion slot resolution at runtime', () => {
  const resolved = loadResolvedDemoProject();

  it('resolves every state through a slot, never a clip id', () => {
    const resolver = motionResolverFor(resolved);
    for (const state of resolved.graph.states) {
      expect(resolver.resolve(state.motionSlot, {})).toBeDefined();
    }
  });

  it('resolves a contextual binding for each weapon mode', () => {
    const resolver = motionResolverFor(resolved);
    const clips = ['unarmed', 'sword', 'magic', 'pistol', 'shield', 'throw'].map(
      (contextKey) => resolver.resolve('action.primary.01', { contextKey })?.id,
    );
    expect(new Set(clips).size).toBe(clips.length);
  });

  it('falls back to the default binding for an unknown context', () => {
    const resolver = motionResolverFor(resolved);
    expect(resolver.resolve('action.primary.01', { contextKey: 'no-such-weapon' })?.id).toBe(
      resolver.resolve('action.primary.01', {})?.id,
    );
  });
});

describe('every replay fixture runs for both characters', () => {
  it.each(REPLAY_FIXTURES.map((replay) => replay.id))('%s', (replayId) => {
    const replay = REPLAY_FIXTURES.find((entry) => entry.id === replayId)!;
    for (const character of project.characters) {
      const trace = runReplay(loadResolvedDemoProject(character.id), replay);
      expect(trace.ticks).toHaveLength(replay.tickCount);
      expect(summarizeTrace(trace).traceHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
