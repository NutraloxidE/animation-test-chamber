/**
 * The canonical Character inventory, and the sharing matrix it produces
 * (work package §11.1, §11.5).
 *
 * These read the real `project.json` and the real assets rather than a
 * hand-built fixture, for the reason the rest of this suite does: a matrix
 * asserted against a fixture stays green while the repository the app actually
 * loads says something else.
 *
 * The assertions are exact — five ids, named holders, exact counts — not
 * "at least". A `toBeGreaterThan(1)` on a holder count is satisfied by a
 * Character silently joining a shared asset, which is the change these tests
 * exist to notice.
 */
import { describe, expect, it } from 'vitest';
import {
  describeCharacterBinding,
  describeCharacterBindings,
  modelBindingKey,
  otherHolders,
} from '@atc/animation-asset-runtime';
import { demoRegistry, loadDemoProject, loadResolvedDemoProject } from '../../fixtures/project.ts';

const project = loadDemoProject();
const registry = demoRegistry();
const bindings = describeCharacterBindings(project, registry);

/** The five Characters the repository is intended to declare, in order. */
const EXPECTED_IDS = [
  'demo-humanoid',
  'alternate-humanoid-character',
  'sentinel',
  'quaternius-knight',
  'quaternius-universal-base',
];

describe('canonical Character inventory', () => {
  it('declares exactly the five intended Characters', () => {
    expect(project.characters.map((character) => character.id)).toEqual(EXPECTED_IDS);
  });

  it('gives every Character a unique id', () => {
    expect(new Set(EXPECTED_IDS).size).toBe(EXPECTED_IDS.length);
  });

  it('gives every Character an explicit model binding', () => {
    for (const character of project.characters) {
      expect(character.model).toBeDefined();
      expect(['procedural-humanoid', 'repository-model']).toContain(character.model.kind);
      if (character.model.kind === 'procedural-humanoid') {
        expect(character.model.presetId.length).toBeGreaterThan(0);
      } else {
        expect(character.model.assetPath.startsWith('/assets/')).toBe(true);
      }
    }
  });

  it('binds three procedural appearances and two imported models', () => {
    const kinds = project.characters.map((character) => character.model.kind);
    expect(kinds.filter((kind) => kind === 'procedural-humanoid')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'repository-model')).toHaveLength(2);
  });

  it('gives every Character a distinct model — none is another one in disguise', () => {
    const keys = project.characters.map((character) => modelBindingKey(character.model));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('resolves every Character to a runnable document', () => {
    for (const id of EXPECTED_IDS) {
      const resolved = loadResolvedDemoProject(id);
      expect(resolved.character.id).toBe(id);
      expect(resolved.graph.states.length).toBeGreaterThan(0);
    }
  });

  it('points activeCharacterId at one of them', () => {
    expect(EXPECTED_IDS).toContain(project.activeCharacterId);
  });

  it('references only real Characters from Scene entities', () => {
    for (const scene of project.scenes) {
      for (const entity of scene.entities) {
        if (entity.kind !== 'character') continue;
        expect(EXPECTED_IDS).toContain(entity.characterId);
      }
    }
  });
});

describe('sharing matrix', () => {
  const of = (id: string) => bindings.find((entry) => entry.characterId === id)!;

  it('shares one Behavior across all five, and says exactly who', () => {
    for (const id of EXPECTED_IDS) {
      const behavior = of(id).behavior;
      expect(behavior.reference.assetId).toBe('humanoid-third-person-base');
      expect(behavior.usedByCharacterIds).toEqual([...EXPECTED_IDS].sort());
      expect(otherHolders(behavior, id)).toHaveLength(4);
    }
  });

  it('shares the demo rig across the three procedural Characters only', () => {
    const holders = ['alternate-humanoid-character', 'demo-humanoid', 'sentinel'];
    for (const id of holders) {
      expect(of(id).rig.reference.assetId).toBe('demo-humanoid-rig');
      expect(of(id).rig.usedByCharacterIds).toEqual(holders);
      expect(of(id).rig.ownership).toBe('shared');
    }
  });

  it('gives each imported model its own rig, and says ONLY THIS CHARACTER', () => {
    expect(of('quaternius-knight').rig.reference.assetId).toBe('quaternius-knight-rig');
    expect(of('quaternius-knight').rig.ownership).toBe('only-this-character');
    expect(of('quaternius-knight').rig.usedByCharacterIds).toEqual(['quaternius-knight']);

    expect(of('quaternius-universal-base').rig.reference.assetId).toBe('quaternius-universal-rig');
    expect(of('quaternius-universal-base').rig.ownership).toBe('only-this-character');
  });

  it('shares one Motion Set between Navigator and Sentinel, and lists both', () => {
    for (const id of ['demo-humanoid', 'sentinel']) {
      expect(of(id).motionSet.reference.assetId).toBe('demo-humanoid-motion-set');
      expect(of(id).motionSet.usedByCharacterIds).toEqual(['demo-humanoid', 'sentinel']);
      expect(of(id).motionSet.ownership).toBe('shared');
    }
  });

  it('keeps Relay’s Motion Set Character-specific', () => {
    const motionSet = of('alternate-humanoid-character').motionSet;
    expect(motionSet.reference.assetId).toBe('alternate-humanoid-motion-set');
    expect(motionSet.ownership).toBe('only-this-character');
    expect(otherHolders(motionSet, 'alternate-humanoid-character')).toEqual([]);
  });

  /*
   * Tuning ownership is *computed*, and the demo project is why it has to be:
   * "tuning is per-Character" was true of the old two-Character repository and
   * is false of this one. A UI that assumed it would offer "only this character"
   * for a save reaching four.
   */
  it('computes Tuning holders rather than assuming they are per-Character', () => {
    const shared = ['demo-humanoid', 'quaternius-knight', 'quaternius-universal-base', 'sentinel'];
    for (const id of shared) {
      expect(of(id).tuning?.reference.assetId).toBe('demo-default-tuning');
      expect(of(id).tuning?.usedByCharacterIds).toEqual(shared);
      expect(of(id).tuning?.ownership).toBe('shared');
    }
    const relay = of('alternate-humanoid-character').tuning;
    expect(relay?.reference.assetId).toBe('alternate-humanoid-tuning');
    expect(relay?.ownership).toBe('only-this-character');
  });

  it('reports the exact instance-override count and paths', () => {
    expect(of('demo-humanoid').instanceOverrideCount).toBe(2);
    expect(of('demo-humanoid').instanceOverridePaths).toEqual([
      '/graph/states/run/speed',
      '/graph/states/walk/speed',
    ]);
    // A Character that patches a shared Behavior locally is OVERRIDDEN, which is
    // the fact that changes a decision — "shared" alone would understate it.
    expect(of('demo-humanoid').behavior.ownership).toBe('overridden');

    for (const id of ['alternate-humanoid-character', 'sentinel', 'quaternius-knight']) {
      expect(of(id).instanceOverrideCount).toBe(0);
      expect(of(id).behavior.ownership).toBe('shared');
    }
  });

  it('marks every model binding as owned by exactly one Character', () => {
    for (const entry of bindings) {
      expect(entry.model.ownership).toBe('only-this-character');
      expect(entry.model.usedByCharacterIds).toEqual([entry.characterId]);
    }
  });

  it('makes imported rig compatibility explicit rather than assumed', () => {
    for (const entry of bindings) {
      // Never silently unknown: an unchecked green badge is worse than none.
      expect(entry.rigCompatibility.status).toBeDefined();
      expect(entry.rigCompatibility.status).toBe('direct-compatible');
      expect(entry.rigCompatibility.motionSetRigId).toBe(entry.rigCompatibility.characterRigId);
    }
  });

  it('gives the Knight an explicit rig identity of its own', () => {
    // The Knight carried no rig id at all before this package, so nothing could
    // say whether another rig's clips would play on it.
    const knight = of('quaternius-knight');
    expect(knight.rigCompatibility.characterRigId).toBe('quaternius-knight-rig');
    expect(knight.rigCompatibility.characterRigId).not.toBe('demo-humanoid-rig');
  });

  it('answers for a single Character identically to the whole inventory', () => {
    for (const id of EXPECTED_IDS) {
      expect(describeCharacterBinding(project, registry, id)).toEqual(
        bindings.find((entry) => entry.characterId === id),
      );
    }
    expect(describeCharacterBinding(project, registry, 'nope')).toBeUndefined();
  });

  it('does not count two versions of one asset as shared', () => {
    /*
     * Version matters: publishing over 1.0.0 reaches the Characters on 1.0.0,
     * and a holder list keyed by asset id alone would over-report the blast
     * radius — which trains people to ignore it.
     */
    const moved = structuredClone(project);
    moved.characters[2]!.animation.motionSet = {
      ...moved.characters[2]!.animation.motionSet,
      version: '2.0.0',
    };
    const after = describeCharacterBindings(moved, registry);
    expect(after[0]!.motionSet.usedByCharacterIds).toEqual(['demo-humanoid']);
    expect(after[0]!.motionSet.ownership).toBe('only-this-character');
  });
});
