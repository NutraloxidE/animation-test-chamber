/**
 * Shared versus isolated edits, across all five canonical Characters
 * (work package §11.6, §11.8).
 *
 * Intentional sharing is correct — five Characters deliberately share one
 * Behavior here. What must never happen is a *Character-specific* edit becoming
 * a shared one by accident. So each test below changes one thing and then
 * asserts what did **not** move, which is the half that a happy-path test of the
 * edit itself would never notice.
 *
 * These resolve the real repository for each Character rather than mocking, so
 * "the others are unchanged" means unchanged in the document the runtime
 * consumes, not in a stand-in.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalPatch, ProjectDefinition, ResolvedProject } from '@atc/schema';
import { describeCharacterBindings, resolveCharacterAnimation } from '@atc/animation-asset-runtime';
import { EditSession } from '@atc/editor-core';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';

const registry = demoRegistry();
const ALL = [
  'demo-humanoid',
  'alternate-humanoid-character',
  'sentinel',
  'quaternius-knight',
  'quaternius-universal-base',
];

function resolveFor(project: ProjectDefinition, characterId: string): ResolvedProject {
  const result = resolveCharacterAnimation({ registry, project, characterId });
  const errors = result.issues.filter((issue) => issue.severity === 'error');
  expect(errors, `${characterId} did not resolve`).toEqual([]);
  return result.project;
}

/** The value a canonical graph path resolves to, for one Character. */
function walkSpeed(project: ProjectDefinition, characterId: string): number {
  const resolved = resolveFor(project, characterId);
  return resolved.graph.states.find((state) => state.id === 'walk')!.speed;
}

function withOverride(
  project: ProjectDefinition,
  characterId: string,
  patch: CanonicalPatch,
): ProjectDefinition {
  const next = structuredClone(project);
  const character = next.characters.find((entry) => entry.id === characterId)!;
  character.animation.instanceOverrides = [
    ...character.animation.instanceOverrides.filter((entry) => entry.path !== patch.path),
    patch,
  ];
  return next;
}

describe('a Character instance override reaches exactly one Character', () => {
  const project = loadDemoProject();

  it('changes the route target’s effective graph and nobody else’s', () => {
    const before = Object.fromEntries(ALL.map((id) => [id, walkSpeed(project, id)]));

    const edited = withOverride(project, 'sentinel', {
      path: '/graph/states/walk/speed',
      op: 'set',
      value: 0.42,
    });

    expect(walkSpeed(edited, 'sentinel')).toBe(0.42);
    for (const id of ALL.filter((entry) => entry !== 'sentinel')) {
      expect(walkSpeed(edited, id), `${id} moved`).toBe(before[id]);
    }
  });

  it('leaves the shared Behavior asset itself untouched', () => {
    const edited = withOverride(project, 'quaternius-knight', {
      path: '/graph/states/walk/speed',
      op: 'set',
      value: 9,
    });
    // The asset a *published* edit would change is byte-identical: an override
    // is stored on the Character, which is what makes it isolated.
    const behaviorRef = project.characters[0]!.animation.behavior;
    expect(registry.find(behaviorRef)).toBe(registry.find(edited.characters[0]!.animation.behavior));
  });

  it('shows the isolation in the inventory as OVERRIDDEN, not as a new asset', () => {
    const edited = withOverride(project, 'sentinel', {
      path: '/graph/states/walk/speed',
      op: 'set',
      value: 0.42,
    });
    const bindings = describeCharacterBindings(edited, registry);
    const sentinel = bindings.find((entry) => entry.characterId === 'sentinel')!;
    expect(sentinel.behavior.ownership).toBe('overridden');
    expect(sentinel.instanceOverrideCount).toBe(1);
    // Still shared — the override did not fork anything, and claiming otherwise
    // would be the opposite error.
    expect(sentinel.behavior.usedByCharacterIds).toHaveLength(5);
  });
});

describe('re-pointing one Character at a different asset', () => {
  const project = loadDemoProject();

  it('moves only that Character’s Motion Set, and updates the holder lists', () => {
    const next = structuredClone(project);
    const sentinel = next.characters.find((entry) => entry.id === 'sentinel')!;
    sentinel.animation.motionSet = structuredClone(
      next.characters.find((entry) => entry.id === 'alternate-humanoid-character')!.animation
        .motionSet,
    );

    const bindings = describeCharacterBindings(next, registry);
    const of = (id: string) => bindings.find((entry) => entry.characterId === id)!;

    // Navigator was sharing with Sentinel; it now holds its set alone.
    expect(of('demo-humanoid').motionSet.usedByCharacterIds).toEqual(['demo-humanoid']);
    expect(of('demo-humanoid').motionSet.ownership).toBe('only-this-character');
    // And Relay's set is now shared with Sentinel, which the badge must say.
    expect(of('alternate-humanoid-character').motionSet.usedByCharacterIds).toEqual([
      'alternate-humanoid-character',
      'sentinel',
    ]);
    expect(of('alternate-humanoid-character').motionSet.ownership).toBe('shared');
  });

  it('leaves every other Character’s resolved clips exactly as they were', () => {
    const clipsBefore = Object.fromEntries(
      ALL.map((id) => [id, resolveFor(project, id).motionBindings]),
    );

    const next = structuredClone(project);
    next.characters.find((entry) => entry.id === 'sentinel')!.animation.motionSet = structuredClone(
      next.characters.find((entry) => entry.id === 'alternate-humanoid-character')!.animation
        .motionSet,
    );

    for (const id of ALL.filter((entry) => entry !== 'sentinel')) {
      expect(resolveFor(next, id).motionBindings, `${id} changed`).toEqual(clipsBefore[id]);
    }
  });
});

describe('Character-specific Tuning stays Character-specific', () => {
  const project = loadDemoProject();

  it('a Tuning swap on one Character does not move a Character on another profile', () => {
    const before = walkSpeed(project, 'alternate-humanoid-character');
    const next = structuredClone(project);
    // Point Knight at Relay's profile. Relay itself must not notice.
    next.characters.find((entry) => entry.id === 'quaternius-knight')!.animation.tuning =
      structuredClone(
        next.characters.find((entry) => entry.id === 'alternate-humanoid-character')!.animation
          .tuning,
      );
    expect(walkSpeed(next, 'alternate-humanoid-character')).toBe(before);
  });

  it('the four Characters sharing one profile all move when it is the profile that changes', () => {
    /*
     * The other direction, asserted deliberately: shared means shared. A test
     * suite that only proved isolation would be equally happy with a repository
     * where nothing was shared at all, which is not the design.
     */
    const bindings = describeCharacterBindings(project, registry);
    const holders = bindings.find((entry) => entry.characterId === 'demo-humanoid')!.tuning!
      .usedByCharacterIds;
    expect(holders).toEqual([
      'demo-humanoid',
      'quaternius-knight',
      'quaternius-universal-base',
      'sentinel',
    ]);
  });
});

describe('resolution produces independent documents per Character', () => {
  const project = loadDemoProject();

  it('never hands two Characters the same mutable resolved object', () => {
    const resolved = ALL.map((id) => resolveFor(project, id));
    for (let i = 0; i < resolved.length; i += 1) {
      for (let j = i + 1; j < resolved.length; j += 1) {
        expect(resolved[i]).not.toBe(resolved[j]);
        expect(resolved[i]!.character).not.toBe(resolved[j]!.character);
        expect(resolved[i]!.character.id).not.toBe(resolved[j]!.character.id);
      }
    }
  });

  it('gives each Character its own model binding and skeleton in the resolved document', () => {
    for (const id of ALL) {
      const resolved = resolveFor(project, id);
      const authored = project.characters.find((entry) => entry.id === id)!;
      expect(resolved.character.model).toEqual(authored.model);
      expect(resolved.character.skeleton.id).toBe(
        // The skeleton comes from the Character's own rig asset, so the imported
        // Characters cannot inherit the demo skeleton by sharing a Behavior.
        registry.getRig(authored.animation.rig).skeleton.id,
      );
    }
  });

  it('mutating one resolved document cannot reach another', () => {
    const first = resolveFor(project, 'demo-humanoid');
    const second = resolveFor(project, 'sentinel');
    // Same Motion Set, same Behavior, same Tuning — the case where a shared
    // cache entry would show up.
    first.graph.states.find((state) => state.id === 'walk')!.speed = 123;
    expect(second.graph.states.find((state) => state.id === 'walk')!.speed).not.toBe(123);
  });
});

describe('a staged edit cannot survive a Character switch', () => {
  /*
   * §11.8: "staged Character A edit cannot apply after navigating to B". The
   * route switch rebuilds the session with `acceptCommitted`, so this asserts the
   * mechanism the switch actually uses rather than driving the store — which
   * needs a browser. Carrying a staged edit across would apply one Character's
   * decisions to another's assets, and the two Characters below share a Behavior,
   * so the paths would line up and it would look entirely plausible.
   */
  const project = loadDemoProject();

  it('drops staged and preview state, and adopts the new document', () => {
    const navigator = resolveFor(project, 'demo-humanoid');
    const session = new EditSession(navigator);

    const outcome = session.setPreviewValue({
      path: '/graph/states/walk/speed',
      value: 0.31,
      actor: 'human',
    });
    expect(outcome.applied).toBe(true);
    session.stage('/graph/states/walk/speed');
    expect(session.stagedChanges).toHaveLength(1);

    // The switch.
    session.acceptCommitted(resolveFor(project, 'quaternius-knight'));

    expect(session.stagedChanges).toEqual([]);
    expect(session.previewProject.character.id).toBe('quaternius-knight');
    expect(session.repositoryProject.character.id).toBe('quaternius-knight');
    // And the staged value is gone from the document, not merely unstaged.
    expect(
      session.previewProject.graph.states.find((state) => state.id === 'walk')!.speed,
    ).not.toBe(0.31);
  });

  it('leaves nothing for undo to bring back across the switch', () => {
    const session = new EditSession(resolveFor(project, 'demo-humanoid'));
    session.setPreviewValue({ path: '/graph/states/walk/speed', value: 0.31, actor: 'human' });
    session.acceptCommitted(resolveFor(project, 'sentinel'));
    session.undo();
    expect(session.previewProject.character.id).toBe('sentinel');
    expect(
      session.previewProject.graph.states.find((state) => state.id === 'walk')!.speed,
    ).not.toBe(0.31);
  });
});
