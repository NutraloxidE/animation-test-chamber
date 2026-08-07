/**
 * One exact subject, built the way the route builds it.
 *
 * The native workspace tests all need the same thing: a Prefab with a real
 * Animator whose assignment resolves against the demo repository, opened
 * through the same authoring session the route opens. Rebuilding that per file
 * is how two test files end up asserting against two subtly different subjects
 * and disagreeing about which one is right, so it is built once here.
 *
 * The assignment comes from the demo repository rather than from the shared
 * Prefab fixtures, whose asset references are deliberately unresolvable — right
 * for schema tests, useless for anything that has to reach a document.
 */
import { animationSubjectFromPrefab } from '@atc/prefab-runtime';
import type { AnimationSubjectDefinition, CharacterAnimationAssignment } from '@atc/schema';
import { REPLAY_FIXTURES } from '@atc/replay-runtime';
import {
  materializeAnimationChamberDocument,
  type AnimationChamberDocument,
  type AnimationChamberRepositoryDefaults,
} from '../../../apps/web/src/animation-chamber/AnimationChamberDocument.ts';
import {
  createAnimationChamberFacade,
  type AnimationChamberFacade,
  type AnimationChamberStore,
} from '../../../apps/web/src/animation-chamber/AnimationChamberFacade.ts';
import { createAnimationAuthoringSession } from '../../../apps/web/src/prefab-editor/animation-authoring-session.ts';
import { ChamberEngine } from '../../../apps/web/src/engine.ts';
import { animatorComponent, basePrefab, modelComponent, node, referenceTo, registryOf } from '../prefabs/fixtures.ts';
import { demoRegistry, loadDemoProject } from '../../fixtures/project.ts';

export function repositoryDefaults(): AnimationChamberRepositoryDefaults {
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

export interface SubjectFixtureOptions {
  withModel?: boolean;
  /** Distinguishes two subjects that must not share state. */
  prefabId?: string;
}

export function subjectFixture(options: SubjectFixtureOptions = {}) {
  const assignment = loadDemoProject().characters[0]!.animation as CharacterAnimationAssignment;
  const components = [
    ...(options.withModel === false ? [] : [modelComponent('navigator')]),
    animatorComponent(assignment),
  ];
  const prefab = basePrefab(options.prefabId ?? 'animated-subject', node('root', components));
  const registry = registryOf(prefab);
  return { registry, reference: referenceTo(prefab), animationRegistry: demoRegistry() };
}

export function subjectOf(options: SubjectFixtureOptions = {}): AnimationSubjectDefinition {
  const { registry, reference, animationRegistry } = subjectFixture(options);
  return animationSubjectFromPrefab({
    registry,
    animationRegistry,
    reference,
    nodeId: 'root',
    componentId: 'animator',
  }).subject!;
}

export function materialize(options: SubjectFixtureOptions = {}): AnimationChamberDocument {
  const { animationRegistry } = subjectFixture(options);
  const subject = subjectOf(options);
  // Resolved through the authoring session rather than the resolver directly,
  // so the document under test is the one the workspace actually edits.
  let document!: AnimationChamberDocument;
  const repository = repositoryDefaults();
  createAnimationAuthoringSession({
    subject,
    animationRegistry,
    baseRevisionId: repository.revisionId,
    createEngine: (resolved) => {
      document = materializeAnimationChamberDocument({ resolved, repository });
      return { dispose: () => {} };
    },
  }).dispose();
  return document;
}

export interface ChamberFixture {
  facade: AnimationChamberFacade;
  engine: ChamberEngine;
  store: AnimationChamberStore;
  subject: AnimationSubjectDefinition;
}

/** A live facade over one exact subject, engine included. */
export function chamber(options: SubjectFixtureOptions = {}): ChamberFixture {
  const { animationRegistry } = subjectFixture(options);
  const subject = subjectOf(options);
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
  return { facade, engine, store: facade.store, subject };
}

/** A blend duration that exists on the demo graph, for edit round-trips. */
export function firstTransitionPath(store: AnimationChamberStore): string {
  return `/graph/transitions/${store.getState().project.graph.transitions[0]!.id}/blendDurationSec`;
}
