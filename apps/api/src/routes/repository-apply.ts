/**
 * `POST /api/repository/apply` — the one validated write for a route target.
 *
 * Apply is the only step in Preview → Stage → Validate → Apply that touches the
 * repository, and five things about it are load-bearing:
 *
 *   1. It replays the *typed operations* server-side, after checking each one
 *      against a runtime schema. A full-document request would ask the server to
 *      trust a document the client assembled, and a client that mis-assembled
 *      one would be indistinguishable from a client that meant it. A TypeScript
 *      union is not a check: this endpoint receives JSON.
 *
 *   2. It enforces protection itself. The browser session checks it too, but a
 *      check that only exists in the browser is not a rule — it is a habit of
 *      one client, and `curl` does not have it.
 *
 *   3. It refuses on a stale baseline rather than overwriting. Two people (or a
 *      human and an agent) editing one scene must not have the second write
 *      silently erase the first, and "last writer wins" is exactly what makes
 *      that invisible.
 *
 *   4. It writes the project and its report as one transaction. Two sequential
 *      writes are two outcomes, and the pair that survives a failure between
 *      them is a repository whose revision no report describes.
 *
 *   5. It does not create a Git commit. Committing is a separate, separately
 *      invocable action; an Apply that quietly committed would make every
 *      exploratory save a public change.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import type { ProjectDefinition, SceneDefinition, ValidationIssue } from '@atc/schema';
import { validateProject, validateProjectReferences } from '@atc/schema';
import { evaluateEdit, type EditActor } from '@atc/runtime-core';
import {
  applySceneOperation,
  parseSceneOperation,
  type RepositoryDocumentTarget,
  type SceneOperation,
} from '@atc/editor-core';
import {
  runRepositoryTransaction,
  sha256Hex,
  type PlannedFileWrite,
} from '@atc/repository-transaction';
import { loadProject, PROJECT_PATH } from '../context.ts';
import { repositoryReportFile } from '../reports.ts';
import { markRepositoryFatal } from '../repository-health.ts';
import type { RepositoryRuntime } from '../runtime.ts';

export interface RepositoryApplyRequestBody {
  target: RepositoryDocumentTarget;
  expected: { projectRevisionId: string };
  operations: SceneOperation[];
  actor: EditActor;
  intent: string;
  /**
   * Paths a human unlocked for the duration of their session.
   *
   * Honoured for `actor: 'human'` only. An unlock is a human gesture in front of
   * a specific value; letting a request declare its own unlocks for an AI actor
   * would make `locked` mean nothing at all, since the caller that wants past
   * the lock is exactly the caller filling in this field.
   */
  unlockedPaths?: string[];
  /** A human's explicit sign-off on an approval-required change. */
  approved?: boolean;
}

export interface RepositoryApplyResponseBody {
  ok: boolean;
  issues: ValidationIssue[];
  project?: ProjectDefinition;
  targetDocument?: SceneDefinition;
  changedPaths?: string[];
  reportPath?: string;
  /** Present when the applied operations produced no change at all. */
  unchanged?: boolean;
}

function issue(path: string, message: string, keyword: string): ValidationIssue {
  return { path, message, keyword };
}

/**
 * A revision id derived from the document's *content*, so it cannot drift from
 * it.
 *
 * `revisionId` itself is excluded from the hash. Including it would make each
 * id a function of the previous one, so identical content reached by two routes
 * would carry two different revisions — and a no-op Apply would mint a new
 * revision, invalidating every other open session in exchange for no change.
 */
export function revisionOf(project: ProjectDefinition): string {
  const { revisionId: _ignored, ...content } = project;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

function projectContent(project: ProjectDefinition): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

export function repositoryApplyRoutes(app: Hono, runtime: RepositoryRuntime): void {
  const root = runtime.repoRoot;

  app.post('/api/repository/apply', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json<RepositoryApplyResponseBody>(
        { ok: false, issues: [issue('/', 'request body is not valid JSON', 'shape')] },
        400,
      );
    }
    const body = raw as Partial<RepositoryApplyRequestBody>;

    if (!body.target || !body.expected || !Array.isArray(body.operations)) {
      return c.json<RepositoryApplyResponseBody>(
        { ok: false, issues: [issue('/', 'target, expected and operations are required', 'shape')] },
        400,
      );
    }

    const actor: EditActor = body.actor ?? 'human';
    if (actor !== 'human' && actor !== 'ai') {
      return c.json<RepositoryApplyResponseBody>(
        { ok: false, issues: [issue('/actor', `unknown actor "${String(body.actor)}"`, 'enum')] },
        400,
      );
    }

    /*
     * An AI request may never carry its own approval or its own unlocks.
     *
     * `approval-required` exists so a human decides; a flag the AI sets itself
     * is the AI deciding, with a field named as if a human had. Refused rather
     * than ignored: a caller that believed it was approving something needs to
     * be told it was not, and an ignored field looks exactly like an honoured
     * one from the outside.
     */
    if (actor === 'ai' && (body.approved === true || (body.unlockedPaths?.length ?? 0) > 0)) {
      return c.json<RepositoryApplyResponseBody>(
        {
          ok: false,
          issues: [
            issue(
              '/approved',
              'an AI actor cannot carry its own approval or unlocks; a human must apply the approved change',
              'protection',
            ),
          ],
        },
        403,
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

    // Every operation is parsed before any of them is applied. A request whose
    // fourth operation is unrecognisable must not have its first three replayed
    // and then be refused — that is a partial edit the caller never asked for.
    const operations: SceneOperation[] = [];
    for (const [position, candidate] of body.operations.entries()) {
      const parsed = parseSceneOperation(candidate);
      if (!parsed.ok) {
        return c.json<RepositoryApplyResponseBody>(
          {
            ok: false,
            issues: parsed.issues.map((entry) => ({
              ...entry,
              path: `/operations/${position}${entry.path === '/' ? '' : entry.path}`,
            })),
          },
          400,
        );
      }
      operations.push(parsed.operation);
    }

    const unlocked = new Set(actor === 'human' ? (body.unlockedPaths ?? []) : []);

    let scene = project.scenes[index]!;
    const changedPaths: string[] = [];
    for (const [position, operation] of operations.entries()) {
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

      /*
       * Protection is evaluated against the paths the operation actually
       * touched, on the document as it stood before it — the same evaluation,
       * against the same root, that `DocumentEditSession.dispatch` performs in
       * the browser. Two implementations of "which paths does this touch" is how
       * the two answers start to differ.
       */
      const refusals: ValidationIssue[] = [];
      for (const path of result.changedPaths ?? []) {
        const decision = evaluateEdit(scene, {
          path,
          actor,
          ...(body.approved === true && actor === 'human' ? { approved: true } : {}),
          unlocked: unlocked.has(path),
        });
        if (decision.allowed) continue;
        refusals.push({
          path: `/operations/${position}${path}`,
          message: decision.reason || `protection refuses this edit by ${actor}`,
          keyword: decision.requiresApproval ? 'approval-required' : 'protection',
        });
      }
      if (refusals.length > 0) {
        return c.json<RepositoryApplyResponseBody>({ ok: false, issues: refusals }, 403);
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

    /*
     * An Apply whose operations cancel out writes nothing.
     *
     * Reported as success, because it is one — the repository holds exactly what
     * the caller asked for — but with `unchanged: true` and no report, so the
     * history does not accumulate entries for edits that changed no byte. The
     * content-derived revision is what makes this detectable at all — compared
     * against the *recomputed* revision of what is on disk, never against its
     * stored `revisionId`, which was minted by whatever wrote it last.
     */
    if (proposed.revisionId === revisionOf(project)) {
      return c.json<RepositoryApplyResponseBody>({
        ok: true,
        issues: [],
        project,
        targetDocument: scene,
        changedPaths: [],
        unchanged: true,
      });
    }

    const report = repositoryReportFile({
      target: body.target,
      baseRevisionId: project.revisionId,
      newRevisionId: proposed.revisionId,
      actor,
      intent: body.intent ?? '',
      changedPaths,
      operations: operations.map((operation) => operation.type),
      files: [PROJECT_PATH],
    });

    const writes: PlannedFileWrite[] = [
      { repositoryPath: PROJECT_PATH, mode: 'replace', content: projectContent(proposed) },
      { repositoryPath: report.path, mode: 'create', content: report.contents },
    ];

    // Optimistic concurrency the transaction engine re-checks under its own
    // write lock. The revision check above is the one the human reads; this is
    // the one that holds when a second writer lands between the two.
    const currentBytes = readFileSync(resolve(root, PROJECT_PATH));
    const result = await runRepositoryTransaction(
      root,
      {
        intent: body.intent ?? `apply to ${body.target.kind} ${body.target.id}`,
        expected: {
          projectRevisionId: project.revisionId,
          files: [
            {
              repositoryPath: PROJECT_PATH,
              expectedSha256: sha256Hex(new Uint8Array(currentBytes)),
            },
          ],
        },
        writes,
        // The candidate was fully validated above, against the same documents
        // the engine is about to promote. Re-deriving it from the prepared view
        // would be a second implementation of "is this project valid".
        validatePreparedView: () => ({ issues: [] }),
      },
      runtime.transactionOptions,
    );

    if (!result.ok) {
      if (result.state === 'fatal') {
        markRepositoryFatal(
          runtime.health,
          result.transactionId,
          result.issues.map((entry) => entry.message).join('; '),
        );
      }
      const transactionIssues = result.issues.map((entry) =>
        issue(entry.path ?? '/', entry.message, entry.code),
      );
      return c.json<RepositoryApplyResponseBody>(
        {
          ok: false,
          issues:
            transactionIssues.length > 0
              ? transactionIssues
              : [issue('/', `apply transaction ${result.state}`, result.state)],
        },
        result.state === 'fatal' ? 503 : 409,
      );
    }

    return c.json<RepositoryApplyResponseBody>({
      ok: true,
      issues: [],
      project: proposed,
      targetDocument: scene,
      changedPaths,
      reportPath: report.path,
    });
  });
}
