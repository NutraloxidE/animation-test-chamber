/**
 * One `DocumentEditSession` per Scene route target, and its lifecycle.
 *
 * A route change disposes the previous session and builds a new one keyed on
 * the new id (work package §5.4). Reusing a session across ids is the bug this
 * prevents: Scene A's staged operations would replay against Scene B, and
 * because the operations are typed and mostly valid, several of them would
 * succeed.
 *
 * `DocumentEditSession` is a mutable object rather than immutable state, so a
 * revision counter is what tells React something changed. That is deliberate —
 * the session owns undo, staging and provenance, and copying it on every
 * keystroke to satisfy a renderer would make those histories the renderer's
 * problem.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { GameObjectSceneOperation, ProjectDefinition, SceneDefinition } from '@atc/schema';
import { validateSceneGameObjectReferences } from '@atc/schema';
import { prefabCapabilityLookup, type PrefabCapabilities } from '@atc/prefab-runtime';
import {
  DocumentEditSession,
  applySceneGameObjectOperation,
  exactPrefabReferenceKey,
  type OperationResult,
} from '@atc/editor-core';
import { applyToRepository, type ApplyOutcome } from '../editor/apply-client.ts';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { useChamber } from '../store.ts';

export interface SceneSessionHandle {
  session: DocumentEditSession<SceneDefinition, GameObjectSceneOperation>;
  /** The staged-or-previewed scene the UI renders from. Never the repository one. */
  scene: SceneDefinition;
  dispatch: (operation: GameObjectSceneOperation) => OperationResult<SceneDefinition>;
  lastIssues: OperationResult<SceneDefinition>['issues'];
  /** What a Prefab this Scene stands on can do. Read by the Inspector's refusals. */
  capabilities: (reference: Parameters<typeof exactPrefabReferenceKey>[0]) =>
    | PrefabCapabilities
    | undefined;
  stageAll: () => void;
  revert: () => void;
  undo: () => void;
  redo: () => void;
  /** Sends the staged operations to the repository. Never writes on its own. */
  apply: (intent: string) => Promise<ApplyOutcome>;
  /** The outcome of the last Apply, for the status line. */
  lastApply: ApplyOutcome | null;
  applying: boolean;
  revision: number;
}

export function useSceneSession(
  project: ProjectDefinition,
  scene: SceneDefinition,
): SceneSessionHandle {
  const [revision, setRevision] = useState(0);
  const [lastIssues, setLastIssues] = useState<OperationResult<SceneDefinition>['issues']>([]);
  const [lastApply, setLastApply] = useState<ApplyOutcome | null>(null);
  const [applying, setApplying] = useState(false);
  const adoptAppliedProject = useChamber((state) => state.adoptAppliedProject);

  /*
   * The operation context, built from the browser's Prefab registry.
   *
   * The same two things the server builds for itself (§9): the exact-reference
   * set an operation may name, and the resolved-Component lookup its refusals
   * are made against. Building it here as well is not duplication of the
   * *rule* — the rule lives in `applySceneGameObjectOperation` — it is what
   * lets the editor refuse at the control the human just moved rather than
   * several seconds later at Apply.
   */
  const prefabRegistry = browserPrefabRegistry();
  const operationContext = useMemo(
    () => ({
      knownPrefabKeys: new Set(
        prefabRegistry
          .all()
          .map((stored) =>
            exactPrefabReferenceKey(prefabRegistry.referenceTo(stored.id, stored.version)),
          ),
      ),
      capabilities: prefabCapabilityLookup(prefabRegistry),
    }),
    [prefabRegistry],
  );

  /*
   * Keyed on the scene id *and* the repository revision. A session that
   * survived an external repository change would be staging operations against
   * a baseline that no longer exists, and its Apply would be refused later with
   * no indication of when it went stale.
   */
  const key = `${scene.id}:${project.revisionId}`;
  const keyRef = useRef(key);
  const sessionRef = useRef<DocumentEditSession<
    SceneDefinition,
    GameObjectSceneOperation
  > | null>(null);

  if (sessionRef.current === null || keyRef.current !== key) {
    keyRef.current = key;
    sessionRef.current = new DocumentEditSession<SceneDefinition, GameObjectSceneOperation>({
      target: { kind: 'scene', id: scene.id },
      baseRevisionId: project.revisionId,
      document: scene,
      apply: (document, operation) =>
        applySceneGameObjectOperation(document, operation, operationContext),
      /*
       * The GameObject view is what production validates. The entity mirror is
       * passed through untouched by every operation, so validating it here
       * would let a mirror that went stale under some earlier migration refuse
       * an edit that never looked at it (DECISION 0025).
       */
      validate: (document) => validateSceneGameObjectReferences(document),
    });
  }
  const session = sessionRef.current;

  const bump = useCallback(() => setRevision((value) => value + 1), []);

  const dispatch = useCallback(
    (operation: GameObjectSceneOperation) => {
      const result = session.dispatch(operation);
      // Refusals are shown, not thrown: the human needs the reason next to the
      // control they just moved.
      setLastIssues(result.issues);
      bump();
      return result;
    },
    [session, bump],
  );

  return {
    session,
    scene: session.previewDocument,
    dispatch,
    lastIssues,
    capabilities: operationContext.capabilities,
    stageAll: useCallback(() => {
      session.stageAll();
      bump();
    }, [session, bump]),
    revert: useCallback(() => {
      session.revert();
      setLastIssues([]);
      bump();
    }, [session, bump]),
    undo: useCallback(() => {
      session.undo();
      bump();
    }, [session, bump]),
    redo: useCallback(() => {
      session.redo();
      bump();
    }, [session, bump]),
    apply: useCallback(
      async (intent: string) => {
        setApplying(true);
        const outcome = await applyToRepository(session.buildApplyRequest(intent));
        /*
         * The session adopts a new baseline only after the repository reports
         * success, so it can never claim a write that did not land — and a
         * failure deliberately leaves the staged operations in place, because
         * the next move is usually to fix one issue and apply again.
         */
        if (outcome.status === 'applied') {
          /*
           * Both baselines move in the same turn, and neither is allowed to
           * move without the other.
           *
           * `acceptApplied` moves the session's private revision — which is
           * what lets a second Apply from this page succeed instead of being
           * refused as a conflict with the first. `adoptAppliedProject` moves
           * the application's canonical state — which is what makes the applied
           * scene survive navigating away and back.
           *
           * Doing only the first was the defect: the open session could apply
           * repeatedly while every other reader of the repository still saw
           * pre-Apply content. Both calls are synchronous, so no render
           * observes one without the other.
           */
          session.acceptApplied(outcome.targetDocument, outcome.project.revisionId);
          adoptAppliedProject(outcome.project);
          setLastIssues([]);
        } else if (outcome.status === 'no-change') {
          /*
           * Nothing was written, so there is no new revision to adopt and the
           * session's baseline is still correct. The staged operations are
           * cleared against the unchanged document because they *were* applied
           * — the server replayed them and they produced what was already
           * there. Leaving them staged would offer the human a pending write
           * that can only ever be another no-change.
           */
          session.acceptApplied(outcome.targetDocument, outcome.project.revisionId);
          setLastIssues([]);
        } else {
          setLastIssues(outcome.status === 'unavailable' ? [] : outcome.issues);
        }
        setLastApply(outcome);
        setApplying(false);
        bump();
        return outcome;
      },
      [session, bump, adoptAppliedProject],
    ),
    lastApply,
    applying,
    revision,
  };
}
