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
import type { ProjectDefinition, SceneDefinition } from '@atc/schema';
import { validateSceneReferences } from '@atc/schema';
import {
  DocumentEditSession,
  applySceneOperation,
  type OperationResult,
  type SceneOperation,
} from '@atc/editor-core';
import { applyToRepository, type ApplyOutcome } from '../editor/apply-client.ts';

export interface SceneSessionHandle {
  session: DocumentEditSession<SceneDefinition, SceneOperation>;
  /** The staged-or-previewed scene the UI renders from. Never the repository one. */
  scene: SceneDefinition;
  dispatch: (operation: SceneOperation) => OperationResult<SceneDefinition>;
  lastIssues: OperationResult<SceneDefinition>['issues'];
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
  const characterIds = useMemo(
    () => new Set(project.characters.map((entry) => entry.id)),
    [project],
  );

  /*
   * Keyed on the scene id *and* the repository revision. A session that
   * survived an external repository change would be staging operations against
   * a baseline that no longer exists, and its Apply would be refused later with
   * no indication of when it went stale.
   */
  const key = `${scene.id}:${project.revisionId}`;
  const keyRef = useRef(key);
  const sessionRef = useRef<DocumentEditSession<SceneDefinition, SceneOperation> | null>(null);

  if (sessionRef.current === null || keyRef.current !== key) {
    keyRef.current = key;
    sessionRef.current = new DocumentEditSession<SceneDefinition, SceneOperation>({
      target: { kind: 'scene', id: scene.id },
      baseRevisionId: project.revisionId,
      document: scene,
      apply: (document, operation) => applySceneOperation(document, operation, project),
      validate: (document) => validateSceneReferences(document, characterIds),
    });
  }
  const session = sessionRef.current;

  const bump = useCallback(() => setRevision((value) => value + 1), []);

  const dispatch = useCallback(
    (operation: SceneOperation) => {
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
          // The revision the repository reported back, not the one this session
          // opened at: applying twice without a reload is the ordinary case, and
          // the second Apply has to declare the first one's result.
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
      [session, bump],
    ),
    lastApply,
    applying,
    revision,
  };
}
