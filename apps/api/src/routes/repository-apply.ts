/**
 * `POST /api/repository/apply` — the one validated write for a route target.
 *
 * Apply is the only step in Preview → Stage → Validate → Apply that touches the
 * repository, and three things about it are load-bearing:
 *
 *   1. It replays the *typed operations* server-side. A full-document request
 *      would ask the server to trust a document the client assembled, and a
 *      client that mis-assembled one would be indistinguishable from a client
 *      that meant it. Replaying is how the server can refuse a write it does
 *      not understand.
 *
 *   2. It refuses on a stale baseline rather than overwriting. Two people (or a
 *      human and an agent) editing one scene must not have the second write
 *      silently erase the first, and "last writer wins" is exactly what makes
 *      that invisible.
 *
 *   3. It does not create a Git commit. Committing is a separate, separately
 *      invocable action; an Apply that quietly committed would make every
 *      exploratory save a public change.
 */
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { ProjectDefinition, SceneDefinition, ValidationIssue } from '@atc/schema';
import { validateProject, validateProjectReferences } from '@atc/schema';
import {
  applySceneOperation,
  type RepositoryDocumentTarget,
  type SceneOperation,
} from '@atc/editor-core';
import { loadProject, saveProject, REPO_ROOT, PROJECT_PATH } from '../context.ts';
import { writeRepositoryReport } from '../reports.ts';

export interface RepositoryApplyRequestBody {
  target: RepositoryDocumentTarget;
  expected: { projectRevisionId: string };
  operations: SceneOperation[];
  actor: 'human' | 'ai';
  intent: string;
}

export interface RepositoryApplyResponseBody {
  ok: boolean;
  issues: ValidationIssue[];
  project?: ProjectDefinition;
  targetDocument?: SceneDefinition;
  changedPaths?: string[];
  reportPath?: string;
}

function issue(path: string, message: string, keyword: string): ValidationIssue {
  return { path, message, keyword };
}

/** A revision id derived from the document itself, so it cannot drift from it. */
export function revisionOf(project: ProjectDefinition): string {
  return createHash('sha256').update(JSON.stringify(project)).digest('hex').slice(0, 16);
}

export function repositoryApplyRoutes(app: Hono, root: string = REPO_ROOT): void {
  app.post('/api/repository/apply', async (c) => {
    const body = (await c.req.json()) as Partial<RepositoryApplyRequestBody>;

    if (!body.target || !body.expected || !Array.isArray(body.operations)) {
      return c.json<RepositoryApplyResponseBody>(
        { ok: false, issues: [issue('/', 'target, expected and operations are required', 'shape')] },
        400,
      );
    }

    const project = loadProject(root);

    /*
     * The revision check comes before anything else, and compares against the
     * *current* document rather than a cached one. A check performed after the
     * operations were replayed would still refuse the write, but would have
     * spent the replay deciding what to refuse — and, worse, would report
     * issues from a document nobody is going to keep.
     */
    if (body.expected.projectRevisionId !== project.revisionId) {
      return c.json<RepositoryApplyResponseBody>(
        {
          ok: false,
          issues: [
            issue(
              '/revisionId',
              `Apply refused: target revision changed (session opened at "${body.expected.projectRevisionId}", repository is at "${project.revisionId}")`,
              'conflict',
            ),
          ],
        },
        409,
      );
    }

    if (body.target.kind !== 'scene') {
      return c.json<RepositoryApplyResponseBody>(
        {
          ok: false,
          issues: [
            issue(
              '/target/kind',
              `target kind "${body.target.kind}" is not applied through this endpoint yet; character-owned and animation-asset edits keep their existing destination flow`,
              'unsupported',
            ),
          ],
        },
        400,
      );
    }

    // The server resolves the target by id from canonical data. It does not
    // trust a client-supplied label, and never an array position.
    const index = project.scenes.findIndex((scene) => scene.id === (body.target as { id: string }).id);
    if (index === -1) {
      return c.json<RepositoryApplyResponseBody>(
        { ok: false, issues: [issue('/target/id', `no scene "${body.target.id}"`, 'reference')] },
        404,
      );
    }

    let scene = project.scenes[index]!;
    const changedPaths: string[] = [];
    for (const [position, operation] of body.operations.entries()) {
      const result = applySceneOperation(scene, operation, project);
      if (!result.ok || result.document === undefined) {
        return c.json<RepositoryApplyResponseBody>(
          {
            ok: false,
            issues: result.issues.map((entry) => ({
              ...entry,
              path: `/operations/${position}${entry.path}`,
            })),
          },
          422,
        );
      }
      scene = result.document;
      changedPaths.push(...(result.changedPaths ?? []));
    }

    const scenes = [...project.scenes];
    scenes[index] = scene;
    const candidate: ProjectDefinition = { ...project, scenes };
    const proposed: ProjectDefinition = { ...candidate, revisionId: revisionOf(candidate) };

    const issues = [
      ...validateProject(proposed).issues,
      ...validateProjectReferences(proposed).issues,
    ];
    if (issues.length > 0) {
      // Nothing was written: the repository is exactly as it was, and the
      // caller's staged work is still theirs to fix and resubmit.
      return c.json<RepositoryApplyResponseBody>({ ok: false, issues }, 422);
    }

    saveProject(proposed, root);

    const reportPath = writeRepositoryReport(root, {
      target: body.target,
      baseRevisionId: project.revisionId,
      newRevisionId: proposed.revisionId,
      actor: body.actor ?? 'human',
      intent: body.intent ?? '',
      changedPaths,
      operations: body.operations.map((operation) => operation.type),
      files: [PROJECT_PATH],
    });

    return c.json<RepositoryApplyResponseBody>({
      ok: true,
      issues: [],
      project: proposed,
      targetDocument: scene,
      changedPaths,
      reportPath,
    });
  });
}
