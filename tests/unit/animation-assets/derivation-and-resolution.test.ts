import { describe, expect, it } from 'vitest';
import type {
  AnimationBehaviorAsset,
  AnimationMotionSetAsset,
  AnimationTuningProfileAsset,
} from '@atc/schema';
import {
  AnimationAssetRegistry,
  applyPatches,
  checkDeletePolicy,
  checkMotionSetCompatibility,
  computeContentHash,
  createBehaviorFork,
  createBehaviorVariant,
  diffToPatches,
  duplicateBehavior,
  fallbackCycles,
  orphanedAssets,
  protectionWeakenings,
  resolveBehaviorAsset,
  resolveCharacterAnimation,
  retargetStatusBetween,
  sealAsset,
  transitiveDependencies,
  usedBy,
  type StoredAsset,
} from '@atc/animation-asset-runtime';
import { demoRegistry, loadDemoAssets, loadDemoProject } from '../../fixtures/project.ts';

const BEHAVIOR_ID = 'humanoid-third-person-base';
const registry = demoRegistry();
const project = loadDemoProject();
const behaviorRef = registry.referenceTo('animation-behavior', BEHAVIOR_ID, '1.0.0');

/** A registry containing the repository's assets plus some proposed ones. */
function registryWith(...extra: StoredAsset[]): AnimationAssetRegistry {
  return new AnimationAssetRegistry([...loadDemoAssets(), ...extra]);
}

function stored(asset: { metadata: { assetType: string; id: string; version: string } }): StoredAsset {
  return {
    assetType: asset.metadata.assetType as StoredAsset['assetType'],
    id: asset.metadata.id,
    version: asset.metadata.version,
    document: asset as StoredAsset['document'],
  };
}

describe('behaviour variants', () => {
  const variant = createBehaviorVariant(
    registry,
    behaviorRef,
    [{ path: '/transitions/idle-to-walk/blendDurationSec', op: 'set', value: 0.02 }],
    {
      newAssetId: 'humanoid-snappy',
      displayName: 'Snappy',
      createdBy: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  );

  it('stores patches, not a copy of the parent', () => {
    expect(variant.derivation.mode).toBe('variant');
    // The absence of a graph is the whole property: a variant that carried one
    // would silently stop tracking its parent.
    expect(variant.graph).toBeUndefined();
    expect(JSON.stringify(variant).length).toBeLessThan(
      JSON.stringify(registry.get(behaviorRef)).length / 4,
    );
  });

  it('resolves to the parent graph with the patch applied', () => {
    const resolved = resolveBehaviorAsset(
      registryWith(stored(variant)),
      registryWith(stored(variant)).referenceTo('animation-behavior', 'humanoid-snappy', '1.0.0'),
    );
    expect(resolved.issues).toEqual([]);
    expect(
      resolved.graph.transitions.find((entry) => entry.id === 'idle-to-walk')!.blendDurationSec,
    ).toBe(0.02);
    // Everything not patched still comes from the parent.
    expect(resolved.graph.states.length).toBe(registry.getBehavior(behaviorRef).graph!.states.length);
    expect(resolved.lineage.map((entry) => entry.assetId)).toEqual([BEHAVIOR_ID, 'humanoid-snappy']);
  });

  it('refuses a variant chain that loops back on itself', () => {
    // Two variants naming each other as parent. Recursing would be a stack
    // overflow at project-load time with nothing useful to report. Resolving
    // "loop-a" reaches "loop-b" (whose embedded parent reference must carry
    // loop-a's *real* hash to pass `checkReference`), then loop-a again — at
    // which point the cycle is caught by `seen` before that second
    // reference's hash is ever consulted, so it can stay a placeholder.
    const b = sealAsset<AnimationBehaviorAsset>({
      ...variant,
      metadata: { ...variant.metadata, id: 'loop-b' },
      derivation: {
        mode: 'variant',
        parent: {
          assetType: 'animation-behavior',
          assetId: 'loop-a',
          version: '1.0.0',
          contentHash: '0'.repeat(64),
        },
        patches: [],
      },
    });
    const a = sealAsset<AnimationBehaviorAsset>({
      ...variant,
      metadata: { ...variant.metadata, id: 'loop-a' },
      derivation: {
        mode: 'variant',
        parent: {
          assetType: 'animation-behavior',
          assetId: 'loop-b',
          version: '1.0.0',
          contentHash: computeContentHash(b),
        },
        patches: [],
      },
    });
    const looped = registryWith(stored(a), stored(b));
    const resolved = resolveBehaviorAsset(looped, looped.referenceTo('animation-behavior', 'loop-a', '1.0.0'));
    expect(resolved.issues.map((issue) => issue.code)).toContain('circular-variant');
  });

  it('refuses a variant that weakens the parent’s protection', () => {
    const parentGraph = registry.getBehavior(behaviorRef).graph!;
    const locked = applyPatches(
      parentGraph,
      [{ path: '/states/idle/protection', op: 'set', value: { level: 'locked' } }],
      { source: 'base-behavior' },
    ).document;
    const weakened = applyPatches(
      locked,
      [{ path: '/states/idle/protection/level', op: 'set', value: 'editable' }],
      { source: 'behavior-variant' },
    ).document;
    const findings = protectionWeakenings(locked, weakened);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ from: 'locked', to: 'editable' });
  });

  it('reports a patch that addresses nothing in the parent', () => {
    const broken = createBehaviorVariant(
      registry,
      behaviorRef,
      [{ path: '/states/does-not-exist/speed', op: 'set', value: 2 }],
      { newAssetId: 'broken-variant', displayName: 'Broken', createdBy: 'test', createdAt: '2026-01-01T00:00:00.000Z' },
    );
    const withBroken = registryWith(stored(broken));
    const resolved = resolveBehaviorAsset(
      withBroken,
      withBroken.referenceTo('animation-behavior', 'broken-variant', '1.0.0'),
    );
    expect(resolved.issues.map((issue) => issue.code)).toContain('invalid-patch-path');
  });
});

describe('forks and duplicates', () => {
  const { asset: fork } = createBehaviorFork(registry, behaviorRef, 'diverging for the boss', {
    newAssetId: 'humanoid-boss',
    displayName: 'Boss',
    createdBy: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('a fork carries its own graph', () => {
    expect(fork.derivation.mode).toBe('fork');
    expect(fork.graph?.states.length).toBe(registry.getBehavior(behaviorRef).graph!.states.length);
  });

  it('a fork resolves with the parent absent', () => {
    // Only the fork is in this registry — no parent to fall back to.
    const detached = new AnimationAssetRegistry([stored(fork)]);
    const resolved = resolveBehaviorAsset(
      detached,
      detached.referenceTo('animation-behavior', 'humanoid-boss', '1.0.0'),
    );
    expect(resolved.issues).toEqual([]);
    expect(resolved.graph.states.length).toBeGreaterThan(0);
  });

  it('a fork keeps its origin as provenance, not as a dependency', () => {
    const withFork = registryWith(stored(fork));
    const reference = withFork.referenceTo('animation-behavior', 'humanoid-boss', '1.0.0');
    expect(fork.metadata.assetProvenance?.forkedFrom?.assetId).toBe(BEHAVIOR_ID);
    expect(transitiveDependencies(withFork, reference)).toEqual([]);
  });

  it('a duplicate becomes an independent base asset', () => {
    const { asset } = duplicateBehavior(registry, behaviorRef, {
      newAssetId: 'humanoid-copy',
      displayName: 'Copy',
      createdBy: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(asset.derivation.mode).toBe('base');
    expect(asset.metadata.assetProvenance?.duplicatedFrom?.assetId).toBe(BEHAVIOR_ID);
    expect(asset.graph?.id).toBe('humanoid-copy');
  });
});

describe('motion slots and compatibility', () => {
  const behavior = registry.getBehavior(behaviorRef);
  const motionSetRef = registry.referenceTo(
    'animation-motion-set',
    'demo-humanoid-motion-set',
    '1.0.0',
  );
  const rigRef = registry.referenceTo('humanoid-rig', 'demo-humanoid-rig', '1.0.0');

  it('the demo motion set satisfies the behaviour', () => {
    const result = checkMotionSetCompatibility(
      registry,
      behavior,
      registry.getMotionSet(motionSetRef),
      rigRef,
    );
    expect(result.missingSlots).toEqual([]);
    expect(result.compatible).toBe(true);
    expect(result.retargetStatus).toBe('direct-compatible');
  });

  it('reports a required slot the motion set does not bind', () => {
    const motionSet = registry.getMotionSet(motionSetRef);
    const stripped = sealAsset<AnimationMotionSetAsset>({
      ...motionSet,
      bindings: motionSet.bindings.filter((binding) => binding.motionSlot !== 'locomotion.idle'),
    });
    const result = checkMotionSetCompatibility(registry, behavior, stripped, rigRef);
    expect(result.missingSlots).toContain('locomotion.idle');
    expect(result.compatible).toBe(false);
  });

  it('a fallback binding satisfies an unbound slot', () => {
    const motionSet = registry.getMotionSet(motionSetRef);
    const withFallback = sealAsset<AnimationMotionSetAsset>({
      ...motionSet,
      bindings: motionSet.bindings.filter((binding) => binding.motionSlot !== 'locomotion.walk'),
      fallbackBindings: [{ missingSlot: 'locomotion.walk', fallbackSlot: 'locomotion.idle' }],
    });
    const result = checkMotionSetCompatibility(registry, behavior, withFallback, rigRef);
    expect(result.missingSlots).not.toContain('locomotion.walk');
  });

  it('refuses a fallback chain that loops', () => {
    const cycles = fallbackCycles([
      { id: 'a', displayName: 'a', required: true, fallbackSlot: 'b', tags: [] },
      { id: 'b', displayName: 'b', required: true, fallbackSlot: 'a', tags: [] },
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('refuses a duplicate binding for the same slot and context', () => {
    const motionSet = registry.getMotionSet(motionSetRef);
    const duplicated = sealAsset<AnimationMotionSetAsset>({
      ...motionSet,
      bindings: [...motionSet.bindings, motionSet.bindings[0]!],
    });
    const result = checkMotionSetCompatibility(registry, behavior, duplicated, rigRef);
    expect(result.issues.map((issue) => issue.code)).toContain('duplicate-binding');
  });

  it('grades rig compatibility rather than playing silently', () => {
    const rig = registry.getRig(rigRef);
    expect(retargetStatusBetween(rig, rig)).toBe('direct-compatible');

    const mirrored = { ...rig, compatibilityKey: 'other', coordinateSystem: { ...rig.coordinateSystem, handedness: 'left' as never } };
    expect(retargetStatusBetween(mirrored, rig)).toBe('conversion-required');

    const renamed = { ...rig, compatibilityKey: 'other' };
    expect(retargetStatusBetween(renamed, rig)).toBe('retarget-compatible');
  });
});

describe('resolution order', () => {
  it('applies base, tuning and character overrides in that order', () => {
    // Each layer sets the same path; the last one applied has to win.
    const tuning = sealAsset<AnimationTuningProfileAsset>({
      metadata: {
        schemaVersion: 2,
        assetType: 'animation-tuning',
        id: 'order-test-tuning',
        version: '1.0.0',
        displayName: 'Order test',
        description: '',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'test',
        contentHash: '',
      },
      compatibleBehavior: behaviorRef,
      patches: [{ path: '/transitions/idle-to-walk/blendDurationSec', op: 'set', value: 0.11 }],
    });

    const withTuning = registryWith(stored(tuning));
    const tuningRef = withTuning.referenceTo('animation-tuning', 'order-test-tuning', '1.0.0');

    const tuned = resolveCharacterAnimation({
      registry: withTuning,
      project: {
        ...project,
        characters: project.characters.map((character, index) =>
          index === 0
            ? { ...character, animation: { ...character.animation, tuning: tuningRef } }
            : character,
        ),
      },
      characterId: project.characters[0]!.id,
    });
    expect(
      tuned.project.graph.transitions.find((entry) => entry.id === 'idle-to-walk')!
        .blendDurationSec,
    ).toBe(0.11);

    const overridden = resolveCharacterAnimation({
      registry: withTuning,
      project: {
        ...project,
        characters: project.characters.map((character, index) =>
          index === 0
            ? {
                ...character,
                animation: {
                  ...character.animation,
                  tuning: tuningRef,
                  instanceOverrides: [
                    {
                      path: '/graph/transitions/idle-to-walk/blendDurationSec',
                      op: 'set' as const,
                      value: 0.22,
                    },
                  ],
                },
              }
            : character,
        ),
      },
      characterId: project.characters[0]!.id,
    });
    expect(
      overridden.project.graph.transitions.find((entry) => entry.id === 'idle-to-walk')!
        .blendDurationSec,
    ).toBe(0.22);
  });

  it('records where each resolved value came from', () => {
    const resolved = resolveCharacterAnimation({ registry, project });
    const sources = new Set(resolved.project.resolution.map((entry) => entry.source));
    expect(sources.has('motion-set')).toBe(true);
    expect(
      resolved.project.resolution.every((entry) => typeof entry.canonicalPath === 'string'),
    ).toBe(true);
  });

  it('refuses a tuning profile that would change structure', () => {
    const structural = sealAsset<AnimationTuningProfileAsset>({
      metadata: {
        schemaVersion: 2,
        assetType: 'animation-tuning',
        id: 'structural-tuning',
        version: '1.0.0',
        displayName: 'Structural',
        description: '',
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'test',
        contentHash: '',
      },
      compatibleBehavior: behaviorRef,
      patches: [{ path: '/states/idle', op: 'remove' }],
    });
    const withStructural = registryWith(stored(structural));
    const result = resolveCharacterAnimation({
      registry: withStructural,
      project: {
        ...project,
        characters: project.characters.map((character, index) =>
          index === 0
            ? {
                ...character,
                animation: {
                  ...character.animation,
                  tuning: withStructural.referenceTo(
                    'animation-tuning',
                    'structural-tuning',
                    '1.0.0',
                  ),
                },
              }
            : character,
        ),
      },
      characterId: project.characters[0]!.id,
    });
    expect(result.issues.map((issue) => issue.code)).toContain('tuning-changes-structure');
    // The state survives, because the patch was refused rather than applied.
    expect(result.project.graph.states.some((state) => state.id === 'idle')).toBe(true);
  });

  it('keeps one character’s overrides out of another’s document', () => {
    const [first, second] = project.characters;
    const withOverride = {
      ...project,
      characters: project.characters.map((character) =>
        character.id === first!.id
          ? {
              ...character,
              animation: {
                ...character.animation,
                instanceOverrides: [
                  {
                    path: '/graph/states/idle/speed',
                    op: 'set' as const,
                    value: 1.75,
                  },
                ],
              },
            }
          : character,
      ),
    };
    const a = resolveCharacterAnimation({ registry, project: withOverride, characterId: first!.id });
    const b = resolveCharacterAnimation({ registry, project: withOverride, characterId: second!.id });
    expect(a.project.graph.states.find((state) => state.id === 'idle')!.speed).toBe(1.75);
    expect(b.project.graph.states.find((state) => state.id === 'idle')!.speed).not.toBe(1.75);
  });
});

describe('dependencies', () => {
  it('a motion set depends on its rig and every clip it binds', () => {
    const motionSetRef = registry.referenceTo(
      'animation-motion-set',
      'demo-humanoid-motion-set',
      '1.0.0',
    );
    const dependencies = transitiveDependencies(registry, motionSetRef);
    expect(dependencies.some((entry) => entry.assetType === 'humanoid-rig')).toBe(true);
    expect(dependencies.filter((entry) => entry.assetType === 'animation-clip').length).toBeGreaterThan(
      5,
    );
  });

  it('used-by finds the characters holding a reference', () => {
    const holders = usedBy(registry, behaviorRef, [project]);
    const characters = holders.filter((entry) => 'kind' in entry.holder);
    expect(characters.length).toBe(2);
  });

  it('refuses to delete an asset a character still references', () => {
    const policy = checkDeletePolicy(registry, behaviorRef, [project]);
    expect(policy.allowed).toBe(false);
    // A refusal enumerates who is holding on, or the reader has to go hunting.
    expect(policy.reasons.length).toBeGreaterThan(0);
    expect(policy.reasons.join(' ')).toContain('references it at');
  });

  it('allows deleting an asset nothing references', () => {
    const { asset } = duplicateBehavior(registry, behaviorRef, {
      newAssetId: 'unreferenced',
      displayName: 'Unreferenced',
      createdBy: 'test',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const withOrphan = registryWith(stored(asset));
    const reference = withOrphan.referenceTo('animation-behavior', 'unreferenced', '1.0.0');
    expect(checkDeletePolicy(withOrphan, reference, [project]).allowed).toBe(true);
    expect(orphanedAssets(withOrphan, [project]).some((entry) => entry.assetId === 'unreferenced')).toBe(
      true,
    );
  });
});

describe('patches', () => {
  it('round-trips a diff back into the document that produced it', () => {
    const before = registry.getBehavior(behaviorRef).graph!;
    const after = applyPatches(
      before,
      [{ path: '/states/idle/speed', op: 'set', value: 1.5 }],
      { source: 'behavior-variant' },
    ).document;
    const patches = diffToPatches(before, after, '');
    expect(patches).toEqual([{ path: '/states/idle/speed', op: 'set', value: 1.5 }]);
    expect(applyPatches(before, patches, { source: 'behavior-variant' }).document).toEqual(after);
  });

  it('reports an append and a remove rather than rewriting the array', () => {
    const before = { items: [{ id: 'a', value: 1 }] };
    const after = { items: [{ id: 'b', value: 2 }] };
    const patches = diffToPatches(before, after, '');
    expect(patches.map((patch) => patch.op).sort()).toEqual(['append', 'remove']);
  });

  it('rejects a set on a path the document does not have when asked to', () => {
    const result = applyPatches(
      { a: 1 },
      [{ path: '/b', op: 'set', value: 2 }],
      { source: 'tuning-profile', requireExistingPath: true },
    );
    expect(result.rejected).toHaveLength(1);
    expect(result.document).toEqual({ a: 1 });
  });
});
