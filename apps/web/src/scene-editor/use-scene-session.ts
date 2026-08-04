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
  revision: number;
}

export function useSceneSession(
  project: ProjectDefinition,
  scene: SceneDefinition,
): SceneSessionHandle {
  const [revision, setRevision] = useState(0);
  const [lastIssues, setLastIssues] = useState<OperationResult<SceneDefinition>['issues']>([]);
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
    revision,
  };
}
