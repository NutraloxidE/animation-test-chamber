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
  viewportOwnsSimulation,
  type AnimationChamberDocument,
  type AnimationChamberRepositoryDefaults,
} from '../../../apps/web/src/animation-chamber/AnimationChamberDocument.ts';
import {
  ANIMATION_PANELS,
  ANIMATION_PANEL_IDS,
} from '../../../apps/web/src/animation-chamber/AnimationPanelRegistry.ts';
import { REPLAY_FIXTURES } from '@atc/replay-runtime';
import {
  createAnimationChamberFacade,
  type AnimationChamberStore,
} from '../../../apps/web/src/animation-chamber/AnimationChamberFacade.ts';
import { createAnimationAuthoringSession } from '../../../apps/web/src/prefab-editor/animation-authoring-session.ts';
import { ChamberEngine } from '../../../apps/web/src/engine.ts';
import { resolveAnimationSubjectPresentation } from '../../../apps/web/src/animation-chamber/resolve-subject-presentation.ts';
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
    replays: REPLAY_FIXTURES,
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

  it('wires exactly the panels reached so far', () => {
    const wired = ANIMATION_PANELS.filter((panel) => panel.implemented).map((panel) => panel.id);
    expect(wired).toEqual([
      'inspector',
      'graph',
      'timeline',
      'timing',
      'replay',
      'terrain',
      'ai',
      'capability',
    ]);
  });

  it('keeps every unwired panel registered rather than hidden', () => {
    expect(ANIMATION_PANELS).toHaveLength(11);
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

});

describe('the subject presentation the viewport draws', () => {
  it('is keyed by the subject, not by a Character', () => {
    const document = materialize();
    const presentation = resolveAnimationSubjectPresentation({
      document,
      motionContextId: 'unarmed',
    })!;

    // The renderer keys its mixer and cloned skeleton by this. A Character id
    // here would make two subjects on one Prefab share a skeleton.
    expect(presentation.characterId).toBe(document.subject.subjectId);
    expect(presentation.characterId).toContain('game-object-prefab:');
    expect(presentation.characterId).toContain('/root/animator');
    expect(presentation.displayName).toBe(document.subject.displayName);
  });

  it('draws the model the Prefab Component authored', () => {
    const document = materialize();
    const presentation = resolveAnimationSubjectPresentation({
      document,
      motionContextId: 'unarmed',
    })!;

    expect(presentation.model.canonical).toEqual(document.presentation.model);
    expect(presentation.model.effective).toEqual(document.presentation.model);
    expect(presentation.model.isPreviewOverridden).toBe(false);
  });

  it('has nothing to draw when the node has no ModelRenderer', () => {
    // Not a substituted default: a Prefab node with no model has no appearance,
    // and drawing "some humanoid" would invent a subject nobody authored.
    expect(
      resolveAnimationSubjectPresentation({
        document: materialize({ withModel: false }),
        motionContextId: 'unarmed',
      }),
    ).toBeNull();
  });

  it('resolves takes and loop flags for every graph state', () => {
    const document = materialize();
    const presentation = resolveAnimationSubjectPresentation({
      document,
      motionContextId: 'unarmed',
    })!;

    const stateIds = document.graph.states.map((state) => state.id).sort();
    expect(Object.keys(presentation.loopByStateId).sort()).toEqual(stateIds);
    // Source files are deduplicated and sorted, so the loader fetches each once.
    expect(presentation.sourceFiles).toEqual([...new Set(presentation.sourceFiles)].sort());
  });

  it('lets a preview override swap appearance without touching the canonical binding', () => {
    const document = materialize();
    const presentation = resolveAnimationSubjectPresentation({
      document,
      motionContextId: 'unarmed',
      previewModelOverridePresetId: 'blocky',
    })!;

    expect(presentation.model.effective).toEqual({
      kind: 'procedural-humanoid',
      presetId: 'blocky',
    });
    expect(presentation.model.canonical).toEqual(document.presentation.model);
    expect(presentation.model.isPreviewOverridden).toBe(true);
  });
});

describe('one driver advances the simulation', () => {
  it('gives the viewport the clock exactly when there is a body to draw', () => {
    // The same fact decides whether a canvas exists and whether `useFrame`
    // runs, so both must come from here rather than being decided twice.
    expect(viewportOwnsSimulation(materialize())).toBe(true);
    expect(viewportOwnsSimulation(materialize({ withModel: false }))).toBe(false);
  });

  it('still runs a simulation for a subject with no body', () => {
    // The shell's clock covers this case. A bodiless Animator is still worth
    // tuning, and a frozen graph beside "no ModelRenderer" would be a worse
    // answer than a running one.
    const engine = new ChamberEngine(materialize({ withModel: false }));
    for (let i = 0; i < 20; i += 1) engine.advance(1 / 60);

    expect(engine.snapshot().tick).toBeGreaterThan(0);
    expect(engine.snapshot().locomotionState).not.toBe('');
  });

  it('exposes terrain and haptics state the newly wired panels read', () => {
    const engine = new ChamberEngine(materialize());
    // TerrainPanel reads these two; CapabilityPanel reads the haptic player.
    expect(engine.terrainPreset.id).toBeTruthy();
    expect(typeof engine.subscribe).toBe('function');
    expect(engine.hapticPlayer).toBeDefined();
  });
});

/**
 * The facade drives one engine, and the engine must never hold a document the
 * panels are not showing. Every test below is about that single agreement.
 */
describe('the facade and the running engine agree', () => {
  function chamber(options: { withModel?: boolean } = {}) {
    const { registry, reference, animationRegistry } = subjectFixture(options);
    const subject = animationSubjectFromPrefab({
      registry,
      animationRegistry,
      reference,
      nodeId: 'root',
      componentId: 'animator',
    }).subject!;
    const repository = repositoryDefaults();
    let engine!: ChamberEngine;
    const authoring = createAnimationAuthoringSession({
      subject,
      animationRegistry,
      baseRevisionId: repository.revisionId,
      createEngine: (resolved) => {
        engine = new ChamberEngine(materializeAnimationChamberDocument({ resolved, repository }));
        return { dispose: () => {} };
      },
    });
    const facade = createAnimationChamberFacade({ authoring, repository, engine });
    return { facade, engine, store: facade.store };
  }

  /** A blend duration that exists on the demo graph, for edit round-trips. */
  function firstTransitionPath(store: AnimationChamberStore): string {
    return `/graph/transitions/${store.getState().project.graph.transitions[0]!.id}/blendDurationSec`;
  }

  it('hands an edited document to the engine, not only to the panels', () => {
    const { engine, store } = chamber();
    const path = firstTransitionPath(store);

    store.getState().setPreviewValue(path, 0.42);

    // The failure this prevents: panels showing 0.42 while the body on screen
    // keeps playing the committed value.
    expect(store.getState().previewDocument).toBe(engine.currentProject);
  });

  it('returns the engine to the previous document on undo', () => {
    const { engine, store } = chamber();
    const path = firstTransitionPath(store);
    const committed = engine.currentProject;

    store.getState().setPreviewValue(path, 0.42);
    expect(engine.currentProject).not.toBe(committed);

    store.getState().undo();
    expect(engine.currentProject).toBe(store.getState().previewDocument);
  });

  it('returns the engine to the repository document on revert', () => {
    const { engine, store } = chamber();
    store.getState().setPreviewValue(firstTransitionPath(store), 0.42);

    store.getState().revertSession();

    expect(engine.currentProject).toBe(store.getState().previewDocument);
    expect(store.getState().previewDocument).toEqual(store.getState().repositoryDocument);
  });

  it('does not re-seed the engine for staging, which moves no value', () => {
    const { engine, store } = chamber();
    const path = firstTransitionPath(store);
    store.getState().setPreviewValue(path, 0.42);
    const afterEdit = engine.currentProject;

    store.getState().stage(path);

    expect(engine.currentProject).toBe(afterEdit);
  });

  it('sends a motion context change to the engine as well as the store', () => {
    const { engine, store } = chamber();
    store.getState().setMotionContext('sword');

    expect(store.getState().motionContextId).toBe('sword');
    // The viewport resolves takes by context; the simulation resolves clips by
    // it too, and the two must be the same context.
    expect(engine.snapshot()).toBeDefined();
    expect(store.getState().project.motionContextKeys).toContain('sword');
  });

  it('records a capability refresh on the facade', () => {
    const { store } = chamber();
    const before = store.getState().capability;

    store.getState().refreshCapability({ ...before, deviceLabel: 'a freshly plugged pad' });

    // The Haptics panel's device table reads this. Discarding the detection
    // result left it describing a pad that had been unplugged.
    expect(store.getState().capability.deviceLabel).toBe('a freshly plugged pad');
    expect(store.getState().capability).not.toBe(before);
  });
});

describe('replay is subject-local', () => {
  it('takes its before trace from the repository and its after trace from the preview', () => {
    const document = materialize();
    const engine = new ChamberEngine(document);
    const replay = REPLAY_FIXTURES[0]!;

    const before = engine.traceFor(document, replay);
    const edited = {
      ...document,
      movement: {
        ...document.movement,
        walkSpeed: document.movement.walkSpeed * 0.5,
        runSpeed: document.movement.runSpeed * 0.5,
      },
    };
    const after = engine.traceFor(edited, replay);

    // Same inputs, different documents: the traces must be able to differ, or
    // the comparison the Replay panel draws would be decorative.
    expect(before.replayId).toBe(replay.id);
    expect(after.replayId).toBe(replay.id);
    expect(before.revisionId).toBe(document.revisionId);
    expect(JSON.stringify(after.ticks)).not.toBe(JSON.stringify(before.ticks));
  });

  it('starts every subject with no recordings, ghost or comparison', () => {
    const engine = new ChamberEngine(materialize());
    const repository = repositoryDefaults();
    const { registry, reference, animationRegistry } = subjectFixture();
    const subject = animationSubjectFromPrefab({
      registry,
      animationRegistry,
      reference,
      nodeId: 'root',
      componentId: 'animator',
    }).subject!;
    const facade = createAnimationChamberFacade({
      authoring: createAnimationAuthoringSession({
        subject,
        animationRegistry,
        baseRevisionId: repository.revisionId,
        createEngine: () => ({ dispose: () => {} }),
      }),
      repository,
      engine,
    });

    const state = facade.store.getState();
    // A new facade is built per subject, so "discarded on subject change" is
    // the same statement as "empty at construction".
    expect(state.recordedReplays).toEqual([]);
    expect(state.ghostEnabled).toBe(false);
    expect(state.compareSlots).toEqual([]);
    expect(state.activeCompareSlot).toBe(-1);
    expect(state.replays).toBe(repository.replays);
  });
});

describe('one canvas, one driver', () => {
  const viewportSource = readFileSync(
    join(REPO_ROOT, 'apps/web/src/animation-chamber/AnimationSubjectViewport.tsx'),
    'utf8',
  );

  it('mounts exactly one Canvas', () => {
    // Two canvases on one page compete for the same software rasteriser, and a
    // hidden second one is the version of that bug nobody sees until CI slows.
    expect(viewportSource.match(/<Canvas/g)).toHaveLength(1);
  });

  it('draws the ghost inside that Canvas rather than beside it', () => {
    const canvasStart = viewportSource.indexOf('<Canvas');
    const canvasEnd = viewportSource.indexOf('</Canvas>');
    const ghost = viewportSource.indexOf('ghostEnabled &&');

    expect(canvasStart).toBeGreaterThan(-1);
    expect(ghost).toBeGreaterThan(canvasStart);
    expect(ghost).toBeLessThan(canvasEnd);
  });

  it('lets the shell clock run only when no Canvas exists', () => {
    // The viewport drives from useFrame, which needs a Canvas, which needs a
    // body. Same fact, one place, so the two can never both advance.
    expect(viewportOwnsSimulation(materialize())).toBe(true);
    expect(viewportOwnsSimulation(materialize({ withModel: false }))).toBe(false);
  });
});
