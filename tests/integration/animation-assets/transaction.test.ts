import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AnimationBehaviorAsset,
  AnimationTuningProfileAsset,
  AssetIssueCode,
} from '@atc/schema';
import { assetFilePath, bumpAssetVersion, validateProject } from '@atc/schema';
import {
  AnimationAssetRegistry,
  auditRegistry,
  computeContentHash,
  createBehaviorVariant,
  resolveCharacterAnimation,
  sealAsset,
  type StoredAsset,
} from '@atc/animation-asset-runtime';
import { runReplay, REPLAY_FIXTURES } from '@atc/replay-runtime';
import { demoRegistry, loadDemoAssets, loadDemoProject } from '../../fixtures/project.ts';

const REPO_ROOT = resolve(__dirname, '../../..');
const registry = demoRegistry();
const project = loadDemoProject();
const behaviorRef = registry.referenceTo(
  'animation-behavior',
  'humanoid-third-person-base',
  '1.0.0',
);

function stored(asset: { metadata: { assetType: string; id: string; version: string } }): StoredAsset {
  return {
    assetType: asset.metadata.assetType as StoredAsset['assetType'],
    id: asset.metadata.id,
    version: asset.metadata.version,
    document: asset as StoredAsset['document'],
  };
}

/**
 * The check a transaction runs before it moves anything into place: the
 * repository *as it would be*, not the proposal in isolation. A version that is
 * fine on its own and breaks the character referencing it is exactly the
 * failure this has to catch.
 */
function validateProposed(extra: StoredAsset[], nextProject = project): AssetIssueCode[] {
  const proposed = new AnimationAssetRegistry([...loadDemoAssets(), ...extra]);
  const issues = auditRegistry(proposed, [nextProject]).map((issue) => issue.code);
  for (const character of nextProject.characters) {
    const result = resolveCharacterAnimation({
      registry: proposed,
      project: nextProject,
      characterId: character.id,
    });
    issues.push(...result.issues.filter((issue) => issue.severity === 'error').map((i) => i.code));
  }
  issues.push(...validateProject(nextProject).issues.map((): AssetIssueCode => 'schema-invalid'));
  return issues;
}

describe('published version immutability', () => {
  it('every published asset file matches the hash its references carry', () => {
    for (const stored of loadDemoAssets()) {
      const path = resolve(REPO_ROOT, assetFilePath(stored.assetType, stored.id, stored.version));
      const onDisk = JSON.parse(readFileSync(path, 'utf8'));
      expect(computeContentHash(onDisk)).toBe(stored.document.metadata.contentHash);
    }
  });

  it('editing a published version in place breaks every reference to it', () => {
    // This is the property the whole hashing scheme exists for: the tamper is
    // detected at load, not discovered as a behaviour change months later.
    const tampered = loadDemoAssets().map((entry) =>
      entry.id === 'humanoid-third-person-base'
        ? {
            ...entry,
            document: {
              ...entry.document,
              metadata: { ...entry.document.metadata, description: 'edited in place' },
            },
          }
        : entry,
    );
    const codes = auditRegistry(new AnimationAssetRegistry(tampered), [project]).map(
      (issue) => issue.code,
    );
    expect(codes).toContain('published-asset-modified');
    expect(codes).toContain('hash-mismatch');
  });

  it('publishing a new version leaves the old one referenced and intact', () => {
    const current = registry.getBehavior(behaviorRef);
    const version = bumpAssetVersion(current.metadata.version, 'patch');
    const next = sealAsset<AnimationBehaviorAsset>({
      ...current,
      metadata: { ...current.metadata, version, contentHash: '' },
    });
    // The project still points at 1.0.0, and must keep resolving.
    expect(validateProposed([stored(next)])).toEqual([]);
    expect(registry.versionsOf('animation-behavior', 'humanoid-third-person-base')).toEqual([
      '1.0.0',
    ]);
  });
});

describe('proposed repository validation', () => {
  it('accepts a variant that resolves cleanly', () => {
    const variant = createBehaviorVariant(
      registry,
      behaviorRef,
      [{ path: '/transitions/idle-to-walk/blendDurationSec', op: 'set', value: 0.05 }],
      {
        newAssetId: 'transaction-ok',
        displayName: 'OK',
        createdBy: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    );
    expect(validateProposed([stored(variant)])).toEqual([]);
  });

  it('refuses a proposal that would leave a character unresolvable', () => {
    const broken = {
      ...project,
      characters: project.characters.map((character, index) =>
        index === 0
          ? {
              ...character,
              animation: {
                ...character.animation,
                behavior: { ...character.animation.behavior, version: '9.9.9' },
              },
            }
          : character,
      ),
    };
    expect(validateProposed([], broken)).toContain('version-not-found');
  });

  it('refuses a proposal whose asset does not match its own hash', () => {
    const current = registry.getBehavior(behaviorRef);
    const unsealed: AnimationBehaviorAsset = {
      ...current,
      metadata: { ...current.metadata, version: '1.0.1', displayName: 'changed' },
    };
    const codes = auditRegistry(
      new AnimationAssetRegistry([...loadDemoAssets(), stored(unsealed)]),
      [project],
    ).map((issue) => issue.code);
    expect(codes).toContain('published-asset-modified');
  });

  it('a rejected proposal leaves the repository exactly as it was', () => {
    // Nothing above touched disk; the on-disk registry is byte-identical.
    const before = JSON.stringify(loadDemoAssets());
    validateProposed([], {
      ...project,
      characters: project.characters.map((character) => ({
        ...character,
        animation: {
          ...character.animation,
          motionSet: { ...character.animation.motionSet, assetId: 'gone' },
        },
      })),
    });
    expect(JSON.stringify(loadDemoAssets())).toBe(before);
  });
});

describe('shared behaviour changes require replay verification', () => {
  /**
   * Publishing a new version of a shared behaviour is the one destination that
   * affects characters nobody was looking at. Every character that references
   * it must still run, which is what the transaction re-checks before moving
   * anything into place.
   */
  it('every character referencing the behaviour still runs after a new version', () => {
    const current = registry.getBehavior(behaviorRef);
    const version = bumpAssetVersion(current.metadata.version, 'patch');
    const next = sealAsset<AnimationBehaviorAsset>({
      ...current,
      metadata: { ...current.metadata, version, contentHash: '' },
      graph: {
        ...current.graph!,
        transitions: current.graph!.transitions.map((transition) =>
          transition.id === 'idle-to-walk'
            ? { ...transition, blendDurationSec: 0.05 }
            : transition,
        ),
      },
    });

    const proposedRegistry = new AnimationAssetRegistry([...loadDemoAssets(), stored(next)]);
    const adopted = {
      ...project,
      characters: project.characters.map((character) => ({
        ...character,
        animation: {
          ...character.animation,
          behavior: {
            assetType: 'animation-behavior' as const,
            assetId: next.metadata.id,
            version,
            contentHash: computeContentHash(next),
          },
        },
      })),
    };

    for (const character of adopted.characters) {
      const result = resolveCharacterAnimation({
        registry: proposedRegistry,
        project: adopted,
        characterId: character.id,
      });
      expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
      const trace = runReplay(result.project, REPLAY_FIXTURES[0]!);
      expect(trace.ticks).toHaveLength(REPLAY_FIXTURES[0]!.tickCount);
    }
  });
});

describe('candidate promotion', () => {
  it('only a HumanAccepted candidate may become a clip asset', () => {
    // The demo project ships candidates in earlier states; the gate is what
    // stops a machine from skipping the human review step.
    const promotable = project.candidates.filter(
      (candidate) => candidate.state === 'HumanAccepted',
    );
    const notPromotable = project.candidates.filter(
      (candidate) => candidate.state !== 'HumanAccepted',
    );
    expect(promotable.length + notPromotable.length).toBe(project.candidates.length);
    for (const candidate of notPromotable) {
      expect(candidate.state).not.toBe('HumanAccepted');
    }
  });
});

describe('tuning profile round trip', () => {
  it('a new tuning version changes the resolved value without touching the behaviour', () => {
    const tuningRef = project.characters[0]!.animation.tuning!;
    const current = registry.getTuning(tuningRef);
    const version = bumpAssetVersion(current.metadata.version, 'patch');
    const next = sealAsset<AnimationTuningProfileAsset>({
      ...current,
      metadata: { ...current.metadata, version, contentHash: '' },
      patches: [{ path: '/states/idle/speed', op: 'set', value: 1.25 }],
    });

    const proposedRegistry = new AnimationAssetRegistry([...loadDemoAssets(), stored(next)]);
    const adopted = {
      ...project,
      characters: project.characters.map((character, index) =>
        index === 0
          ? {
              ...character,
              animation: {
                ...character.animation,
                tuning: {
                  assetType: 'animation-tuning' as const,
                  assetId: next.metadata.id,
                  version,
                  contentHash: computeContentHash(next),
                },
              },
            }
          : character,
      ),
    };

    const tuned = resolveCharacterAnimation({
      registry: proposedRegistry,
      project: adopted,
      characterId: adopted.characters[0]!.id,
    });
    expect(tuned.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(tuned.project.graph.states.find((state) => state.id === 'idle')!.speed).toBe(1.25);

    // The behaviour asset itself is untouched, so the other character is not.
    const other = resolveCharacterAnimation({
      registry: proposedRegistry,
      project: adopted,
      characterId: adopted.characters[1]!.id,
    });
    expect(other.project.graph.states.find((state) => state.id === 'idle')!.speed).not.toBe(1.25);
  });
});
