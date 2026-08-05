/**
 * Adoption target semantics (§18.7, at the level this repository currently
 * implements it).
 *
 * The equality under test is the one that closes the pre-existing defect:
 *
 *   request target ids === planned changed ids
 *
 * and its complement, that everything holding the source and *not* named stays
 * in `untouched`. A confirmation dialog built from the same request object
 * therefore cannot describe a blast radius the plan does not have.
 *
 * The HTTP route and the transaction that would apply a plan are not built yet;
 * see reports/gameobject-prefab-migration-audit.md. These tests pin the
 * decision procedure, which is the part that was ambiguous.
 */
import { describe, expect, it } from 'vitest';
import type { PublishAnimationAndUpdatePrefabsRequest } from '@atc/schema';
import { validateAgainst } from '@atc/schema';
import { describePrefabUsage, planAnimationAdoption, planPrefabAdoption } from '@atc/prefab-runtime';
import { loadCanonicalProject } from '../../../harness/animation-assets.ts';
import { loadPrefabRegistry } from '../../../harness/prefabs.ts';

const project = loadCanonicalProject();
const prefabRegistry = loadPrefabRegistry();
const usage = describePrefabUsage({ prefabRegistry, project });

/** The shared Behavior every migrated character holds. */
const sharedBehavior = project.characters[0]!.animation.behavior;

function holderIds(): string[] {
  return usage
    .filter((entry) =>
      entry.animationReferences.some(
        (reference) =>
          reference.assetId === sharedBehavior.assetId &&
          reference.version === sharedBehavior.version,
      ),
    )
    .map((entry) => entry.prefab.assetId);
}

function animationRequest(
  targetPrefabIds: string[],
  overrides: Partial<PublishAnimationAndUpdatePrefabsRequest['expected']> = {},
): PublishAnimationAndUpdatePrefabsRequest {
  return {
    source: sharedBehavior,
    expected: {
      sourceContentHash: sharedBehavior.contentHash,
      projectRevisionId: project.revisionId,
      prefabReferences: usage
        .filter((entry) => holderIds().includes(entry.prefab.assetId))
        .map((entry) => entry.prefab),
      ...overrides,
    },
    targetPrefabIds,
  };
}

describe('the request contract', () => {
  it('has no scope field to express "shared" or "all"', () => {
    const withScope = { ...animationRequest([]), updateScope: 'shared' };
    expect(validateAgainst('PublishAnimationAndUpdatePrefabsRequest', withScope).valid).toBe(false);
  });

  it('accepts an enumerated target list, including an empty one', () => {
    expect(
      validateAgainst('PublishAnimationAndUpdatePrefabsRequest', animationRequest([])).valid,
    ).toBe(true);
    expect(
      validateAgainst('PublishAnimationAndUpdatePrefabsRequest', animationRequest(['navigator']))
        .valid,
    ).toBe(true);
  });
});

describe('planning an animation adoption', () => {
  it('names the holders the Prefab graph actually has', () => {
    // Every migrated character carries the shared Behavior, plus the abstract
    // base they all inherit it from.
    expect(holderIds()).toContain('navigator');
    expect(holderIds()).toContain('humanoid-character-base');
  });

  it('changes exactly one Prefab when one is named', () => {
    const plan = planAnimationAdoption({
      usage,
      request: animationRequest(['navigator']),
      currentProjectRevisionId: project.revisionId,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.targets.map((target) => target.assetId)).toEqual(['navigator']);
    expect(plan.untouched.map((target) => target.assetId)).not.toContain('navigator');
    expect(plan.untouched.length).toBe(holderIds().length - 1);
  });

  it('changes exactly the three named when three are named', () => {
    const named = ['navigator', 'relay', 'sentinel'];
    const plan = planAnimationAdoption({
      usage,
      request: animationRequest(named),
      currentProjectRevisionId: project.revisionId,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.targets.map((target) => target.assetId).sort()).toEqual([...named].sort());
  });

  it('changes nothing when the target list is empty', () => {
    const plan = planAnimationAdoption({
      usage,
      request: animationRequest([]),
      currentProjectRevisionId: project.revisionId,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.targets).toEqual([]);
    expect(plan.untouched.length).toBe(holderIds().length);
  });

  it('keeps the planned change set equal to the request target set', () => {
    for (const named of [[], ['relay'], ['navigator', 'quaternius-knight']]) {
      const request = animationRequest(named);
      const plan = planAnimationAdoption({
        usage,
        request,
        currentProjectRevisionId: project.revisionId,
      });
      expect(plan.targets.map((target) => target.assetId).sort()).toEqual([...named].sort());
      expect([...request.targetPrefabIds].sort()).toEqual([...named].sort());
    }
  });

  it('refuses a stale holder snapshot rather than recomputing it', () => {
    const request = animationRequest(['navigator'], { prefabReferences: [] });
    const plan = planAnimationAdoption({
      usage,
      request,
      currentProjectRevisionId: project.revisionId,
    });
    expect(plan.conflicts.map((conflict) => conflict.code)).toContain('stale-holder-snapshot');
  });

  it('refuses a stale project revision', () => {
    const plan = planAnimationAdoption({
      usage,
      request: animationRequest(['navigator']),
      currentProjectRevisionId: 'rev-moved-on',
    });
    expect(plan.conflicts.map((conflict) => conflict.code)).toContain('stale-holder-snapshot');
  });

  it('refuses a target that does not hold the source', () => {
    const plan = planAnimationAdoption({
      usage,
      request: animationRequest(['default-scene-camera']),
      currentProjectRevisionId: project.revisionId,
    });
    expect(plan.conflicts.map((conflict) => conflict.code)).toContain(
      'target-does-not-hold-source',
    );
  });
});

describe('planning a prefab adoption', () => {
  const navigator = usage.find((entry) => entry.prefab.assetId === 'navigator')!;

  it('re-points exactly the named Scene instance', () => {
    expect(navigator.sceneInstances.length).toBeGreaterThan(1);
    const first = navigator.sceneInstances[0]!;
    const plan = planPrefabAdoption({
      usage,
      request: {
        source: navigator.prefab,
        expected: {
          sourceContentHash: navigator.prefab.contentHash,
          projectRevisionId: project.revisionId,
          sceneInstanceReferences: navigator.sceneInstances,
        },
        targets: [{ sceneId: first.sceneId, gameObjectId: first.gameObjectId }],
      },
      currentProjectRevisionId: project.revisionId,
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.targets.map((target) => target.gameObjectId)).toEqual([first.gameObjectId]);
    expect(plan.untouched.map((target) => target.gameObjectId)).not.toContain(first.gameObjectId);
    expect(plan.targets.length + plan.untouched.length).toBe(navigator.sceneInstances.length);
  });

  it('refuses a target that is not standing on the source version', () => {
    const plan = planPrefabAdoption({
      usage,
      request: {
        source: navigator.prefab,
        expected: {
          sourceContentHash: navigator.prefab.contentHash,
          projectRevisionId: project.revisionId,
          sceneInstanceReferences: navigator.sceneInstances,
        },
        targets: [{ sceneId: 'two-humanoids-shared-animation', gameObjectId: 'scene-camera' }],
      },
      currentProjectRevisionId: project.revisionId,
    });
    expect(plan.conflicts.map((conflict) => conflict.code)).toContain('unknown-target');
  });
});
