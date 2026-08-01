import { describe, expect, it } from 'vitest';
import type { AssetReference, SaveAnimationChangesRequest } from '@atc/schema';
import { referencesEqual } from '@atc/schema';
import { planSaveAnimationChanges } from '@atc/animation-asset-runtime';
import { demoRegistry, loadDemoProject, loadResolvedDemoProject } from '../../fixtures/project.ts';

const CHARACTER_ID = 'demo-humanoid';

function baseRequest(resolved: ReturnType<typeof loadResolvedDemoProject>): SaveAnimationChangesRequest {
  return {
    characterId: CHARACTER_ID,
    graph: { patches: [], destination: { kind: 'none' } },
    clips: { changes: [], destination: { kind: 'none' } },
    expected: {
      projectRevisionId: resolved.revisionId,
      assetReferences: [
        resolved.character.animation.behavior,
        resolved.character.animation.motionSet,
        resolved.character.animation.rig,
      ],
    },
  };
}

describe('save classification (PLAN Part II §12, §15.3)', () => {
  it('refuses a clip change whose destination is "none" rather than dropping it', () => {
    const registry = demoRegistry();
    const project = loadDemoProject();
    const resolved = loadResolvedDemoProject(CHARACTER_ID);
    const sourceClip = resolved.clipAssetSources['sword-attack-01']!;

    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      clips: {
        changes: [{ sourceClip, clipId: 'sword-attack-01', patches: [{ path: '/durationSec', op: 'set', value: 1 }] }],
        destination: { kind: 'none' },
      },
    };

    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.status).toBe(409);
      expect(plan.error).toMatch(/animation clip data/);
    }
  });

  it('refuses a graph change whose destination is "none" rather than dropping it', () => {
    const registry = demoRegistry();
    const project = loadDemoProject();
    const resolved = loadResolvedDemoProject(CHARACTER_ID);

    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      graph: {
        patches: [{ path: '/transitions/idle-to-walk/blendDurationSec', op: 'set', value: 0.5 }],
        destination: { kind: 'none' },
      },
    };

    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.status).toBe(409);
  });

  it('refuses when an expected asset reference no longer matches (stale hash)', () => {
    const registry = demoRegistry();
    const project = loadDemoProject();
    const resolved = loadResolvedDemoProject(CHARACTER_ID);
    const stale: AssetReference = { ...resolved.character.animation.behavior, contentHash: 'f'.repeat(64) };

    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      expected: { ...baseRequest(resolved).expected, assetReferences: [stale] },
    };

    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.status).toBe(409);
      expect(plan.issues?.[0]?.code).toBe('hash-mismatch');
    }
  });

  it('every staged patch reaches the plan: no patch is silently dropped from a successful save', () => {
    const registry = demoRegistry();
    const project = loadDemoProject();
    const resolved = loadResolvedDemoProject(CHARACTER_ID);
    const sourceClip = resolved.clipAssetSources['sword-attack-01']!;

    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      graph: {
        patches: [{ path: '/transitions/idle-to-walk/blendDurationSec', op: 'set', value: 0.5 }],
        destination: { kind: 'character-override' },
      },
      clips: {
        changes: [{ sourceClip, clipId: 'sword-attack-01', patches: [{ path: '/durationSec', op: 'set', value: 1.2 }] }],
        destination: { kind: 'character-override' },
      },
    };

    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const overridePaths = plan.assignment.instanceOverrides.map((patch) => patch.path);
    expect(overridePaths).toContain('/graph/transitions/idle-to-walk/blendDurationSec');
    expect(overridePaths).toContain('/clips/sword-attack-01/durationSec');
  });
});

describe('save: graph-only destinations (PLAN Part II §30)', () => {
  const registry = demoRegistry();
  const project = loadDemoProject();
  const resolved = loadResolvedDemoProject(CHARACTER_ID);
  const graphPatches = [{ path: '/transitions/idle-to-walk/blendDurationSec', op: 'set' as const, value: 0.09 }];

  it('character override: patch lands with a /graph prefix, no new asset', () => {
    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      graph: { patches: graphPatches, destination: { kind: 'character-override' } },
    };
    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.assets).toHaveLength(0);
    expect(plan.assignment.instanceOverrides.at(-1)).toMatchObject({
      path: '/graph/transitions/idle-to-walk/blendDurationSec',
      value: 0.09,
    });
  });

  it('tuning profile: a new tuning version is published, behaviour untouched', () => {
    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      graph: { patches: graphPatches, destination: { kind: 'tuning-profile' } },
    };
    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.assets).toHaveLength(1);
    expect(plan.assets[0]!.metadata.assetType).toBe('animation-tuning');
    expect(plan.assignment.tuning?.assetId).toBe(plan.assets[0]!.metadata.id);
    expect(plan.assignment.behavior).toEqual(resolved.character.animation.behavior);
  });

  /**
   * A tuning profile stores value changes and nothing else. The dangerous
   * failure is not refusing a structural patch — it is accepting the request,
   * publishing a tuning version, and quietly leaving the structural patch out
   * of it: the human is told the edit was saved, and it was not.
   */
  describe('tuning profile refuses what it cannot store', () => {
    const appendPatch = {
      path: '/states',
      op: 'append' as const,
      value: { id: 'invented-state', motionSlot: 'locomotion.idle.01' },
    };
    const removePatch = { path: '/transitions/idle-to-walk', op: 'remove' as const };

    function tuningRequest(patches: SaveAnimationChangesRequest['graph']['patches']): SaveAnimationChangesRequest {
      return { ...baseRequest(resolved), graph: { patches, destination: { kind: 'tuning-profile' } } };
    }

    it('refuses an append patch instead of dropping it', () => {
      const plan = planSaveAnimationChanges(registry, project, tuningRequest([appendPatch]));
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.status).toBe(409);
      expect(plan.error).toMatch(/behaviour variant|behavior variant/i);
      expect(plan.issues?.map((issue) => issue.code)).toContain('unsupported-tuning-patch');
    });

    it('refuses a remove patch instead of dropping it', () => {
      const plan = planSaveAnimationChanges(registry, project, tuningRequest([removePatch]));
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.status).toBe(409);
      expect(plan.issues?.map((issue) => issue.code)).toContain('unsupported-tuning-patch');
    });

    it('refuses a mixed request entirely rather than saving the half it likes', () => {
      const plan = planSaveAnimationChanges(
        registry,
        project,
        tuningRequest([...graphPatches, appendPatch]),
      );
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.status).toBe(409);
      // The valid `set` is not published on its own: a partial save is a
      // different edit from the one that was requested.
      expect(plan.issues?.every((issue) => issue.path !== graphPatches[0]!.path)).toBe(true);
    });

    it('refuses a set whose path does not exist in the behaviour it tunes', () => {
      const plan = planSaveAnimationChanges(
        registry,
        project,
        tuningRequest([{ path: '/transitions/idle-to-walk/noSuchField', op: 'set', value: 1 }]),
      );
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.status).toBe(409);
      expect(plan.issues?.map((issue) => issue.code)).toContain('invalid-patch-path');
    });

    it('leaves the character assignment untouched when it refuses', () => {
      const before = structuredClone(project.characters.find((c) => c.id === CHARACTER_ID)!.animation);
      const plan = planSaveAnimationChanges(registry, project, tuningRequest([appendPatch]));
      expect(plan.ok).toBe(false);
      expect(project.characters.find((c) => c.id === CHARACTER_ID)!.animation).toEqual(before);
    });

    it('still saves a request that only sets existing values', () => {
      const plan = planSaveAnimationChanges(registry, project, tuningRequest(graphPatches));
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.assets).toHaveLength(1);
      expect(plan.assets[0]!.metadata.assetType).toBe('animation-tuning');
    });
  });

  it('new behaviour variant: a new variant asset is published and adopted', () => {
    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      graph: {
        patches: graphPatches,
        destination: { kind: 'new-behavior-variant', newAssetId: 'test-variant-graph-only', displayName: 'Test' },
      },
    };
    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.assets).toHaveLength(1);
    expect(plan.assets[0]!.metadata.id).toBe('test-variant-graph-only');
    expect(plan.assignment.behavior.assetId).toBe('test-variant-graph-only');
  });

  it('shared behaviour: a new version of the current behaviour is published', () => {
    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      graph: { patches: graphPatches, destination: { kind: 'shared-behavior' } },
    };
    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.assets).toHaveLength(1);
    expect(plan.assets[0]!.metadata.id).toBe(resolved.character.animation.behavior.assetId);
    expect(plan.assets[0]!.metadata.version).not.toBe(resolved.character.animation.behavior.version);
  });
});

describe('save: clip-only destinations (PLAN Part II §15.2, §30)', () => {
  const registry = demoRegistry();
  const project = loadDemoProject();
  const resolved = loadResolvedDemoProject(CHARACTER_ID);

  it('character override: clip patches land under /clips/<id>, no new asset', () => {
    const sourceClip = resolved.clipAssetSources['sword-attack-01']!;
    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      clips: {
        changes: [{ sourceClip, clipId: 'sword-attack-01', patches: [{ path: '/durationSec', op: 'set', value: 0.8 }] }],
        destination: { kind: 'character-override' },
      },
    };
    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.assets).toHaveLength(0);
    expect(plan.assignment.instanceOverrides.at(-1)).toMatchObject({
      path: '/clips/sword-attack-01/durationSec',
      value: 0.8,
    });
  });

  it('new clip version + motion set: one changed clip publishes one new clip version and a new motion-set version', () => {
    const sourceClip = resolved.clipAssetSources['sword-attack-01']!;
    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      clips: {
        changes: [{ sourceClip, clipId: 'sword-attack-01', patches: [{ path: '/durationSec', op: 'set', value: 0.75 }] }],
        destination: { kind: 'new-clip-versions-and-motion-set' },
      },
    };
    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const clipAssets = plan.assets.filter((asset) => asset.metadata.assetType === 'animation-clip');
    const motionSetAssets = plan.assets.filter((asset) => asset.metadata.assetType === 'animation-motion-set');
    expect(clipAssets).toHaveLength(1);
    expect(motionSetAssets).toHaveLength(1);
    expect((clipAssets[0] as { clip: { durationSec: number } }).clip.durationSec).toBe(0.75);
    expect(plan.assignment.motionSet.assetId).toBe(motionSetAssets[0]!.metadata.id);
    expect(plan.assignment.behavior).toEqual(resolved.character.animation.behavior);

    // Only the binding for the changed clip moved to the new version.
    const nextMotionSet = motionSetAssets[0] as unknown as {
      bindings: { motionSlot: string; contextualKey?: string; clip: AssetReference }[];
    };
    const swordBinding = nextMotionSet.bindings.find(
      (binding) => binding.motionSlot === 'action.primary.01' && binding.contextualKey === 'sword',
    );
    expect(swordBinding!.clip.assetId).toBe(clipAssets[0]!.metadata.id);
    expect(swordBinding!.clip.version).toBe(clipAssets[0]!.metadata.version);

    // A sibling contextual binding for the *same slot*, different weapon, is untouched.
    const magicBinding = nextMotionSet.bindings.find(
      (binding) => binding.motionSlot === 'action.primary.01' && binding.contextualKey === 'magic',
    );
    expect(referencesEqual(magicBinding!.clip, sourceClip)).toBe(false);
    expect(magicBinding!.clip.assetId).toBe('magic-attack-01');
  });

  it('two changed clip assets publish two clip versions in the same motion-set version', () => {
    const swordSource = resolved.clipAssetSources['sword-attack-01']!;
    const idleSource = resolved.clipAssetSources['idle']!;
    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      clips: {
        changes: [
          { sourceClip: swordSource, clipId: 'sword-attack-01', patches: [{ path: '/durationSec', op: 'set', value: 0.6 }] },
          { sourceClip: idleSource, clipId: 'idle', patches: [{ path: '/loop', op: 'set', value: false }] },
        ],
        destination: { kind: 'new-clip-versions-and-motion-set' },
      },
    };
    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const clipAssets = plan.assets.filter((asset) => asset.metadata.assetType === 'animation-clip');
    const motionSetAssets = plan.assets.filter((asset) => asset.metadata.assetType === 'animation-motion-set');
    expect(clipAssets).toHaveLength(2);
    expect(motionSetAssets).toHaveLength(1);
  });

  it('mixed graph + clip changes in one save produce one behaviour asset and one clip/motion-set pair', () => {
    const sourceClip = resolved.clipAssetSources['sword-attack-01']!;
    const request: SaveAnimationChangesRequest = {
      ...baseRequest(resolved),
      graph: {
        patches: [{ path: '/transitions/idle-to-walk/blendDurationSec', op: 'set', value: 0.15 }],
        destination: { kind: 'shared-behavior' },
      },
      clips: {
        changes: [{ sourceClip, clipId: 'sword-attack-01', patches: [{ path: '/durationSec', op: 'set', value: 0.65 }] }],
        destination: { kind: 'new-clip-versions-and-motion-set' },
      },
    };
    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const byType = new Set(plan.assets.map((asset) => asset.metadata.assetType));
    expect(byType).toEqual(new Set(['animation-behavior', 'animation-clip', 'animation-motion-set']));
    expect(plan.assignment.behavior.assetId).toBe(resolved.character.animation.behavior.assetId);
    expect(plan.assignment.behavior.version).not.toBe(resolved.character.animation.behavior.version);
    expect(plan.assignment.motionSet.version).not.toBe(resolved.character.animation.motionSet.version);
  });
});
