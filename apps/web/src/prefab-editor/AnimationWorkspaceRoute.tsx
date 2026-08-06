/**
 * `/edit/prefab/:prefabId/animation/:nodeId/:componentId`.
 *
 * The native entry point. It reads three exact ids from the path, resolves the
 * latest version of that Prefab lineage, extracts the exact Animator as an
 * `AnimationSubjectDefinition`, opens an authoring session on it, and mounts
 * the chamber.
 *
 * What it does not do is fall back. An unknown Prefab, an unknown node, an
 * ambiguous node, an unknown Component and a Component that is not an Animator
 * each produce a stated refusal — never the first Animator that happens to be
 * nearby. That rule is the whole reason the route carries three ids instead of
 * one: "the Animator on this Prefab" is not an identity when a node may hold
 * several.
 *
 * The lineage rule matches the Prefab Editor's: the path names an id, the
 * editor opens the latest immutable version, and the header shows the exact
 * version that was resolved.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { animationSubjectFromPrefab } from '@atc/prefab-runtime';
import { AnimationChamber } from '../animation-chamber/AnimationChamber.tsx';
import { AnimationChamberProvider } from '../animation-chamber/AnimationChamberProvider.tsx';
import {
  createAnimationChamberFacade,
  type AnimationChamberFacade,
} from '../animation-chamber/AnimationChamberFacade.ts';
import { createAnimationAuthoringSession } from './animation-authoring-session.ts';
import { ChamberEngine } from '../engine.ts';
import { materializeAnimationChamberDocument } from '../animation-chamber/AnimationChamberDocument.ts';
import { useAnimationRepositoryDefaults } from './animation-repository-defaults.ts';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { resolvePrefabEditorTarget } from './resolve-prefab-editor-target.ts';
import { useChamber } from '../store.ts';
import { ROUTES, prefabEditorPath, routeId } from '../app/routes.ts';
import { NotFoundPage } from '../app/NotFoundPage.tsx';

export function AnimationWorkspaceRoute(): JSX.Element {
  const parameters = useParams();
  const prefabId = routeId(parameters.prefabId);
  const nodeId = routeId(parameters.nodeId);
  const componentId = routeId(parameters.componentId);

  const animationRegistry = useChamber((state) => state.registry);
  const baseRevisionId = useChamber((state) => state.canonicalProject.revisionId);
  const repository = useAnimationRepositoryDefaults();
  const registry = browserPrefabRegistry();

  const target = resolvePrefabEditorTarget(registry, prefabId);

  const extraction = useMemo(() => {
    if (target.status !== 'resolved' || nodeId === null || componentId === null) return undefined;
    return animationSubjectFromPrefab({
      registry,
      animationRegistry,
      reference: target.reference,
      nodeId,
      componentId,
    });
  }, [
    registry,
    animationRegistry,
    nodeId,
    componentId,
    target.status,
    target.status === 'resolved' ? target.reference.contentHash : null,
  ]);

  const subject = extraction?.subject;
  /*
   * The identity that decides whether this is still the same workspace.
   *
   * Every field §10.2 names is in it, the content hash included: a Prefab
   * republished at the same version is a different subject, and a session that
   * survived that change would be editing bytes that no longer exist.
   */
  const subjectKey = subject
    ? [
        subject.source.prefab.assetId,
        subject.source.prefab.version,
        subject.source.prefab.contentHash,
        subject.source.nodeId,
        subject.source.componentId,
      ].join('|')
    : null;

  const [facade, setFacade] = useState<AnimationChamberFacade | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const disposed = useRef<AnimationChamberFacade | null>(null);

  useEffect(() => {
    if (!subject || subjectKey === null) {
      setFacade(null);
      return undefined;
    }
    let created: AnimationChamberFacade | null = null;
    try {
      /*
       * The engine is built from the subject's own document, so what runs is
       * this Animator's graph against the repository's tuning — not a
       * Character's. `ChamberEngine` needs no Character to do it; it never
       * read one.
       *
       * Held in an object rather than a `let` so the reference survives
       * narrowing: it is assigned inside the session's `createEngine`, which
       * runs before the facade reads it.
       */
      const held: { engine?: ChamberEngine } = {};
      const authoring = createAnimationAuthoringSession({
        subject,
        animationRegistry,
        baseRevisionId,
        createEngine: (resolved) => {
          const engine = new ChamberEngine(
            materializeAnimationChamberDocument({ resolved, repository }),
          );
          engine.attachInput();
          held.engine = engine;
          // Detaching is the session's job: the sampler holds window listeners,
          // and a subject switch that left them attached would have two
          // subjects sampling one keyboard.
          return { dispose: () => engine.detachInput() };
        },
      });
      created = createAnimationChamberFacade({
        authoring,
        repository,
        livePreview: held.engine,
      });
      setFailure(null);
      setFacade(created);
    } catch (error) {
      setFacade(null);
      setFailure(error instanceof Error ? error.message : String(error));
    }
    return () => {
      /*
       * Disposal is not tidiness. A session left open across a subject change
       * keeps its engine subscribed, and the next subject's first frame is the
       * previous subject's — the "stale subject frame" §10.2 rules out.
       */
      created?.dispose();
      disposed.current = created;
    };
    // Keyed by subject identity rather than by object reference: the extraction
    // memo produces a new object per render, which would otherwise tear the
    // session down and rebuild it on every keystroke.
  }, [subjectKey, animationRegistry, baseRevisionId, repository]);

  if (prefabId === null || nodeId === null || componentId === null) {
    return (
      <NotFoundPage
        title="Incomplete animation workspace URL"
        detail="The workspace is addressed by Prefab id, node id and Animator component id. All three are required, and none is guessed at."
        links={[{ to: ROUTES.prefabs, label: 'Prefabs' }]}
      />
    );
  }

  if (target.status !== 'resolved') {
    return (
      <NotFoundPage
        title={`No Prefab "${prefabId}"`}
        detail="The URL names the Prefab whose Animator is being authored. It never falls back to another Prefab."
        links={[{ to: ROUTES.prefabs, label: 'Prefabs' }]}
      />
    );
  }

  const errors = extraction?.issues.filter((issue) => issue.severity === 'error') ?? [];
  if (!subject) {
    return (
      <section className="empty-state" data-testid="animation-subject-unresolved">
        <h2>This Animator could not be opened</h2>
        <p>
          <code>
            {target.reference.assetId}@{target.reference.version}
          </code>{' '}
          / <code>{nodeId}</code> / <code>{componentId}</code>
        </p>
        <ul data-testid="animation-subject-issues">
          {errors.map((issue) => (
            <li key={`${issue.code}:${issue.message}`} data-testid={`animation-subject-issue-${issue.code}`}>
              {issue.message}
            </li>
          ))}
        </ul>
        <p className="muted">
          No other Animator is opened in its place. Choose one from the Prefab’s composition.
        </p>
        <a href={prefabEditorPath(target.prefabId)}>Back to Prefab composition</a>
      </section>
    );
  }

  if (failure !== null) {
    return (
      <section className="empty-state" data-testid="animation-session-failed">
        <h2>The authoring session could not be created</h2>
        <p>{failure}</p>
        <a href={prefabEditorPath(target.prefabId)}>Back to Prefab composition</a>
      </section>
    );
  }

  if (!facade) {
    return <p data-testid="animation-subject-loading">Opening the exact animation subject…</p>;
  }

  return (
    <AnimationChamberProvider facade={facade}>
      <AnimationChamber />
    </AnimationChamberProvider>
  );
}
