/**
 * The native animation workspace's first vertical slice.
 *
 * Three things are worth asserting here, and none of them is visual.
 *
 * The route is an identity: three ids, encoded once, and no arrangement of
 * them may resolve to "some Animator nearby". The extraction already refuses an
 * unknown node or a non-Animator Component, and these tests hold it to that —
 * because the failure this replaces is a workspace that opened perfectly while
 * editing the wrong Component.
 *
 * The document is Character-free. That is the architectural claim of the whole
 * restoration, and "no Character reaches the panels" is only true if nothing in
 * the materialised document carries one. A structural assertion keeps that from
 * quietly regressing the first time somebody needs a field that happens to live
 * on a Character.
 *
 * The panel registry matches the donor. §2 forbids dropping a panel because its
 * old source is gone, and `World` had already been dropped once — so the
 * inventory is compared against the donor's list rather than a copy of ours.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { animationSubjectFromPrefab } from '@atc/prefab-runtime';
import { resolveAnimationSubject } from '@atc/animation-asset-runtime';
import type { CharacterAnimationAssignment } from '@atc/schema';
import { prefabAnimationWorkspacePath, ROUTES } from '../../../apps/web/src/app/routes.ts';
import {
  materializeAnimationChamberDocument,
  presentationAvailability,
  groundingAvailability,
  gripAvailability,
  type AnimationChamberDocument,
  type AnimationChamberRepositoryDefaults,
} from '../../../apps/web/src/animation-chamber/AnimationChamberDocument.ts';
import {
  ANIMATION_PANELS,
  ANIMATION_PANEL_IDS,
} from '../../../apps/web/src/animation-chamber/AnimationPanelRegistry.ts';
import {
  createIdleLivePreview,
  isIdleLivePreview,
  type AnimationLivePreview,
  type AnimationPreviewControls,
} from '../../../apps/web/src/animation-chamber/AnimationLivePreview.ts';
import { ChamberEngine } from '../../../apps/web/src/engine.ts';
import {
  animatorComponent,
  basePrefab,
  modelComponent,
  node,
  referenceTo,
  registryOf,
} from '../prefabs/fixtures.ts';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';
import {
  legacyRigWorkspaceRedirect,
  prefabAnimatorLocations,
} from '../../../apps/web/src/prefab-editor/resolve-prefab-editor-target.ts';

const REPO_ROOT = join(__dirname, '../../..');
const DONOR_SHA = '2e5b2a21a269f41aad7f14c00b0cded91233f33f';

function repositoryDefaults(): AnimationChamberRepositoryDefaults {
  const project = loadDemoProject();
  return {
    movement: project.movement,
    rootMotion: project.rootMotion,
    terrain: project.terrain,
    camera: project.camera,
    inputMap: project.inputMap,
    haptics: project.haptics,
    equipment: project.equipment,
    preferences: project.preferences,
    defaultTerrainPresetId: project.defaultTerrainPresetId,
    revisionId: project.revisionId,
  };
}

/**
 * A Prefab whose Animator carries a real, resolvable assignment.
 *
 * The shared fixture assignment names assets that do not exist, which is right
 * for schema tests and useless here: this slice is about resolving a subject
 * all the way to a document, so the assignment comes from the demo repository.
 */
function subjectFixture(options: { withModel?: boolean } = {}) {
  const assignment = loadDemoProject().characters[0]!.animation as CharacterAnimationAssignment;
  const components = [
    ...(options.withModel === false ? [] : [modelComponent('navigator')]),
    animatorComponent(assignment),
  ];
  const prefab = basePrefab('animated-subject', node('root', components));
  const registry = registryOf(prefab);
  return { registry, reference: referenceTo(prefab), animationRegistry: demoRegistry() };
}

function materialize(options: { withModel?: boolean } = {}): AnimationChamberDocument {
  const { registry, reference, animationRegistry } = subjectFixture(options);
  const subject = animationSubjectFromPrefab({
    registry,
    animationRegistry,
    reference,
    nodeId: 'root',
    componentId: 'animator',
  }).subject!;
  const { resolved } = resolveAnimationSubject({ subject, animationRegistry });
  return materializeAnimationChamberDocument({ resolved, repository: repositoryDefaults() });
}

describe('the exact native animation route', () => {
  it('names the Prefab, the node and the Animator Component', () => {
    expect(ROUTES.prefabAnimationWorkspace).toBe(
      '/edit/prefab/:prefabId/animation/:nodeId/:componentId',
    );
  });

  it('encodes each id exactly once', () => {
    expect(prefabAnimationWorkspacePath('a b', 'n/1', 'c d')).toBe(
      '/edit/prefab/a%20b/animation/n%2F1/c%20d',
    );
    // Double encoding is the failure this guards: %2520 resolves to nothing.
    expect(prefabAnimationWorkspacePath('a b', 'n', 'c')).not.toContain('%2520');
  });

  it('is a path, not a query, so the session it owns is addressable', () => {
    expect(prefabAnimationWorkspacePath('p', 'n', 'c')).not.toContain('?');
  });
});

describe('exact Component selection', () => {
  it('opens the Animator the URL names', () => {
    const { registry, reference, animationRegistry } = subjectFixture();
    const result = animationSubjectFromPrefab({
      registry,
      animationRegistry,
      reference,
      nodeId: 'root',
      componentId: 'animator',
    });
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.subject?.source.nodeId).toBe('root');
    expect(result.subject?.source.componentId).toBe('animator');
  });

  it('refuses an unknown node rather than choosing another', () => {
    const { registry, reference, animationRegistry } = subjectFixture();
    const result = animationSubjectFromPrefab({
      registry,
      animationRegistry,
      reference,
      nodeId: 'no-such-node',
      componentId: 'animator',
    });
    expect(result.subject).toBeUndefined();
    expect(result.issues.map((issue) => issue.code)).toContain('unknown-node');
  });

  it('refuses an unknown Component rather than the first Animator nearby', () => {
    const { registry, reference, animationRegistry } = subjectFixture();
    const result = animationSubjectFromPrefab({
      registry,
      animationRegistry,
      reference,
      nodeId: 'root',
      componentId: 'no-such-component',
    });
    expect(result.subject).toBeUndefined();
    expect(result.issues.map((issue) => issue.code)).toContain('unknown-component');
  });

  it('refuses a Component that is not an Animator', () => {
    const { registry, reference, animationRegistry } = subjectFixture();
    const result = animationSubjectFromPrefab({
      registry,
      animationRegistry,
      reference,
      nodeId: 'root',
      componentId: 'model',
    });
    expect(result.subject).toBeUndefined();
    expect(result.issues.map((issue) => issue.code)).toContain('non-animator-component');
  });
});

describe('the Character-free chamber document', () => {
  it('carries everything the slice panels read', () => {
    const document = materialize();
    expect(document.graph.states.length).toBeGreaterThan(0);
    expect(document.graph.transitions.length).toBeGreaterThan(0);
    expect(document.clips.length).toBeGreaterThan(0);
    expect(document.rootMotion.mode).toBeDefined();
    expect(document.haptics.bindings).toBeDefined();
  });

  it('contains no Character, by any of its names', () => {
    const document = materialize();
    expect(document).not.toHaveProperty('character');
    expect(document).not.toHaveProperty('characters');
    expect(document).not.toHaveProperty('activeCharacterId');
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('activeCharacterId');
    expect(serialized).not.toContain('"characters"');
  });

  it('keeps the subject exact identity on the document', () => {
    const document = materialize();
    expect(document.subject.source.prefab.assetId).toBe('animated-subject');
    expect(document.subject.source.nodeId).toBe('root');
    expect(document.subject.source.componentId).toBe('animator');
  });

  it('states what is missing instead of substituting another body', () => {
    // The positive case first: without it, a fixture that never produced a
    // model would make the negative assertion below pass for the wrong reason.
    expect(presentationAvailability(materialize()).available).toBe(true);

    const withoutModel = materialize({ withModel: false });
    const presentation = presentationAvailability(withoutModel);

    expect(presentation.available).toBe(false);
    expect(presentation.missing).toBe('model');
    expect(presentation.reason).toMatch(/no ModelRenderer/i);
    // The point of the structured reason: editing survives the missing body.
    expect(withoutModel.graph.states.length).toBeGreaterThan(0);
  });

  it('reports grounding and grip availability separately from the model', () => {
    const document = materialize();
    expect(groundingAvailability(document).missing).toBe('capsule');
    expect(gripAvailability(document).missing).toBe('equipmentSockets');
  });
});

describe('the panel registry', () => {
  it('reproduces the donor ordering, World included', () => {
    expect(ANIMATION_PANEL_IDS).toEqual([
      'inspector',
      'world',
      'graph',
      'timeline',
      'timing',
      'replay',
      'terrain',
      'ai',
      'diff',
      'capability',
      'acquisition',
    ]);
  });

  it('carries the donor labels', () => {
    const labels = Object.fromEntries(ANIMATION_PANELS.map((panel) => [panel.id, panel.label]));
    expect(labels).toEqual({
      inspector: 'Inspector',
      world: 'World',
      graph: 'Graph',
      timeline: 'Timeline',
      timing: 'Timing',
      replay: 'Replay',
      terrain: 'Terrain',
      ai: 'AI',
      diff: 'Diff',
      capability: 'Haptics',
      acquisition: 'Import',
    });
  });

  it('wires exactly the first vertical slice so far', () => {
    const wired = ANIMATION_PANELS.filter((panel) => panel.implemented).map((panel) => panel.id);
    expect(wired).toEqual(['inspector', 'graph', 'timeline', 'timing']);
  });

  it('keeps every unwired panel registered rather than hidden', () => {
    expect(ANIMATION_PANELS).toHaveLength(11);
  });
});

describe('the idle live preview', () => {
  it('answers every reader without a simulation', () => {
    const preview = createIdleLivePreview({ missing: 'engine', reason: 'no engine' });
    expect(isIdleLivePreview(preview)).toBe(true);
    expect(preview.snapshot().tick).toBe(0);
    expect(preview.snapshot().stateMachine).toEqual({});
    expect(preview.lastRecord).toBeNull();
    expect(preview.graphLayers).toEqual({});
    // Subscribing hands back a working unsubscribe even though nothing fires.
    expect(() => preview.subscribe(() => {})()).not.toThrow();
  });
});

describe('the donor test-id inventory', () => {
  it('names the donor and the identities the slice must preserve', () => {
    const inventory = JSON.parse(
      readFileSync(join(REPO_ROOT, 'tests/fixtures/rig-editor-main-testids.json'), 'utf8'),
    ) as { donorSha: string; allStatic: string[] };

    expect(inventory.donorSha).toBe(DONOR_SHA);
    for (const id of ['transition-inspector', 'state-graph', 'timeline', 'motion-timing']) {
      expect(inventory.allStatic).toContain(id);
    }
    // The Hierarchy identities are the documented exception, not an oversight.
    expect(inventory.allStatic).toContain('character-select');
  });
});

describe('the way into the workspace', () => {
  it('finds every Animator rather than the first', () => {
    const assignment = loadDemoProject().characters[0]!.animation as CharacterAnimationAssignment;
    const twoAnimators = basePrefab(
      'two-animators',
      node('root', [
        { ...animatorComponent(assignment), componentId: 'animator-a' },
        { ...animatorComponent(assignment), componentId: 'animator-b' },
      ]),
    );
    const registry = registryOf(twoAnimators);
    const found = prefabAnimatorLocations(registry, referenceTo(twoAnimators));

    expect(found.map((entry) => entry.componentId)).toEqual(['animator-a', 'animator-b']);
  });

  it('refuses to redirect a legacy rig URL when the choice is not deterministic', () => {
    const assignment = loadDemoProject().characters[0]!.animation as CharacterAnimationAssignment;
    const ambiguous = basePrefab(
      'navigator',
      node('root', [
        { ...animatorComponent(assignment), componentId: 'animator-a' },
        { ...animatorComponent(assignment), componentId: 'animator-b' },
      ]),
    );
    const result = legacyRigWorkspaceRedirect(registryOf(ambiguous), 'demo-humanoid');

    // Picking the first would be the exact fallback the route exists to refuse.
    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') throw new Error('expected an ambiguous redirect');
    expect(result.candidates).toHaveLength(2);
  });

  it('redirects to the exact Animator when there is exactly one', () => {
    const assignment = loadDemoProject().characters[0]!.animation as CharacterAnimationAssignment;
    const single = basePrefab('navigator', node('root', [animatorComponent(assignment)]));
    const result = legacyRigWorkspaceRedirect(registryOf(single), 'demo-humanoid');

    expect(result).toMatchObject({
      status: 'resolved',
      prefabId: 'navigator',
      nodeId: 'root',
      componentId: 'animator',
    });
  });

  it('is a not-found for a legacy id that maps to no Prefab', () => {
    const single = basePrefab('navigator', node('root', [animatorComponent()]));
    expect(legacyRigWorkspaceRedirect(registryOf(single), 'no-such-character').status).toBe(
      'unknown-character',
    );
  });
});

describe('the subject-native preview engine', () => {
  it('runs a real simulation from a Character-free document', () => {
    const engine = new ChamberEngine(materialize());

    const before = engine.snapshot();
    // Wall-clock advance, the same way the workspace clock drives it.
    for (let i = 0; i < 20; i += 1) engine.advance(1 / 60);
    const after = engine.snapshot();

    expect(before.tick).toBe(0);
    expect(after.tick).toBeGreaterThan(before.tick);
    // A running graph resolves a locomotion state; an inert one never would.
    expect(after.locomotionState).not.toBe('');
  });

  it('pauses, frame-steps by exactly one tick, and resets', () => {
    const engine = new ChamberEngine(materialize());
    for (let i = 0; i < 10; i += 1) engine.advance(1 / 60);

    engine.setPaused(true);
    const paused = engine.snapshot().tick;
    for (let i = 0; i < 10; i += 1) engine.advance(1 / 60);
    expect(engine.snapshot().tick).toBe(paused);

    engine.frameStep();
    engine.advance(1 / 60);
    expect(engine.snapshot().tick).toBe(paused + 1);

    engine.reset();
    expect(engine.snapshot().tick).toBe(0);
  });

  it('is the live-preview port the panels read', () => {
    const engine = new ChamberEngine(materialize());
    // Structural, not nominal: the panels never import ChamberEngine.
    const port: AnimationLivePreview = engine;
    const controls: AnimationPreviewControls = engine;

    expect(isIdleLivePreview(port)).toBe(false);
    expect(typeof controls.advance).toBe('function');
    expect(port.graphLayers).toBeDefined();
  });
});
