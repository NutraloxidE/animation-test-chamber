/**
 * `POST /api/repository/apply` — the one validated write for a route target.
 *
 * Apply is the only step in Preview → Stage → Validate → Apply that touches the
 * repository, and six things about it are load-bearing:
 *
 *   1. The *whole request* is checked against a runtime schema before anything
 *      else happens. Not just each operation — the target, the expected
 *      revision, the actor, the intent and the approval too, with every object
 *      boundary closed. This endpoint receives JSON; a TypeScript interface is
 *      a claim about a client, made on that client's behalf, and `curl` never
 *      agreed to it.
 *
 *   2. It replays the *typed operations* server-side. A full-document request
 *      would ask the server to trust a document the client assembled, and a
 *      client that mis-assembled one would be indistinguishable from a client
 *      that meant it.
 *
 *   3. It computes which changed paths are protected, itself, and compares them
 *      against an exact human approval. The browser session checks protection
 *      too, but a check that only exists in the browser is not a rule — it is a
 *      habit of one client.
 *
 *   4. It refuses on a stale baseline rather than overwriting. Two people (or a
 *      human and an agent) editing one scene must not have the second write
 *      silently erase the first, and "last writer wins" is exactly what makes
 *      that invisible.
 *
 *   5. It writes the project and its report as one transaction, and validates
 *      the *prepared bytes* that transaction is about to promote. Two
 *      sequential writes are two outcomes, and the pair that survives a failure
 *      between them is a repository whose revision no report describes.
 *
 *   6. It does not create a Git commit. Committing is a separate, separately
 *      invocable action; an Apply that quietly committed would make every
 *      exploratory save a public change.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import type {
  GameObjectSceneOperation,
  ProjectDefinition,
  ProtectionApproval,
  RepositoryApplyRequest,
  RepositoryApplyServerStatus,
  SceneDefinition,
  ValidationIssue,
} from '@atc/schema';
import {
  validateProject,
  validateProjectReferences,
  validateSceneGameObjectReferences,
} from '@atc/schema';
import { resolveProtection, type EditActor } from '@atc/runtime-core';
import { prefabCapabilityLookup } from '@atc/prefab-runtime';
import {
  applySceneGameObjectOperation,
  changedGameObjectIds,
  exactPrefabReferenceKey,
  parseRepositoryApplyRequest,
} from '@atc/editor-core';
import {
  runRepositoryTransaction,
  sha256Hex,
  type PlannedFileWrite,
  type PreparedRepositoryView,
  type RepositoryTransactionState,
  type TransactionIssue,
} from '@atc/repository-transaction';
import { loadPrefabRegistry, loadProject, PROJECT_PATH } from '../context.ts';
import { repositoryReportFile, type RepositoryApplyReport } from '../reports.ts';
import { markRepositoryFatal } from '../repository-health.ts';
import type { RepositoryRuntime } from '../runtime.ts';

export interface RepositoryApplyResponseBody {
  ok: boolean;
  /**
   * The outcome, as a stable discriminator.
   *
   * The client used to infer its state from an HTTP code plus the shape of the
   * body — `409` meant conflict, anything else non-2xx meant "invalid", and a
   * 200 with a `unchanged` flag meant no change. That collapses genuinely
   * different outcomes together: a rolled-back transaction and a refused
   * validation are not the same event, and a repository that has gone read-only
   * is not a conflict the user can resolve by reloading.
   */
  status: RepositoryApplyServerStatus;
  issues: ValidationIssue[];
  project?: ProjectDefinition;
  targetDocument?: SceneDefinition;
  changedPaths?: string[];
  /**
   * Which GameObjects this Apply actually changed (§9.4).
   *
   * Derived by the server from the operation *result* — the documents before
   * and after — never from anything the request declared. A client-supplied
   * list would be a claim about a computation the server is about to perform
   * itself, and a response echoing it would confirm the client's own guess.
   */
  changedGameObjectIds?: string[];
  reportPath?: string;
  /** This Apply's own identity. Absent for no-change, which writes no report. */
  applyId?: string;
  /** Present when a transaction ran, so an operator can find its journal. */
  transactionId?: string;
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
 *
 * The Apply's `applyId` and the report's timestamps are deliberately *not*
 * inputs here either, for the same reason from the other direction: they are
 * facts about the event, not about the document, and folding them in would make
 * identical content hash differently every time it was reached.
 */
export function revisionOf(project: ProjectDefinition): string {
  const { revisionId: _ignored, ...content } = project;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

function projectContent(project: ProjectDefinition): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

/** HTTP status for each outcome. Distinct outcomes get distinct codes. */
const HTTP_STATUS: Record<RepositoryApplyServerStatus, 200 | 409 | 422 | 500 | 503> = {
  applied: 200,
  'no-change': 200,
  conflict: 409,
  invalid: 422,
  // Non-success, and explicitly its own code: the caller's write did not land,
  // but — unlike a refusal — the repository was touched and put back.
  'rolled-back': 500,
  'repository-read-only': 503,
};

/**
 * Which transaction states mean what to a caller.
 *
 * Every nonfatal result used to become a 409. That told a user to reload and
 * retry when the real answer might have been "your scene is invalid" (retrying
 * cannot help) or "the repository needs a human" (retrying makes it worse).
 */
type FailedApplyStatus = Exclude<RepositoryApplyServerStatus, 'applied' | 'no-change'>;

function outcomeForTransaction(state: RepositoryTransactionState): FailedApplyStatus {
  switch (state) {
    case 'committed':
      // Unreachable: `committed` only ever accompanies `ok: true`. Mapped to a
      // conflict rather than asserted away, because a transaction engine that
      // reported both at once is exactly the case where the caller must not be
      // told their write landed.
      return 'conflict';
    case 'validation-refused':
      return 'invalid';
    case 'conflict-refused':
      return 'conflict';
    case 'rolled-back':
      return 'rolled-back';
    case 'fatal':
      return 'repository-read-only';
    case 'recovered':
      // A transaction the engine resolved during recovery: nothing this caller
      // asked for landed, and its baseline may have moved underneath it.
      return 'conflict';
  }
}

/**
 * The paths this operation changed that a human has to sign off on.
 *
 * "Protected" here means the resolved protection level requires an unlock or an
 * approval — `locked` and `approval-required`. `invariant` is not in this set
 * because it is not approvable by anyone; it is refused separately and
 * unconditionally. `editable` needs nothing.
 *
 * Resolved against the document as it stood *before* the operation ran, because
 * that is where the protection metadata the human set actually lives — an
 * operation that removed a lock would otherwise be judged against the
 * unprotected document it just produced.
 */
function classifyPaths(
  document: unknown,
  changedPaths: readonly string[],
): { protectedPaths: string[]; invariantPaths: string[] } {
  const protectedPaths: string[] = [];
  const invariantPaths: string[] = [];
  for (const path of changedPaths) {
    const { level } = resolveProtection(document, path);
    if (level === 'invariant') invariantPaths.push(path);
    else if (level === 'locked' || level === 'approval-required') protectedPaths.push(path);
  }
  return { protectedPaths, invariantPaths };
}

/** Sorted and deduplicated, so two equal sets compare equal however they arrived. */
function normalizePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((path, index) => path === right[index]);
}

export function repositoryApplyRoutes(app: Hono, runtime: RepositoryRuntime): void {
  const root = runtime.repoRoot;

  app.post('/api/repository/apply', async (c) => {
    function refuse(
      status: Exclude<RepositoryApplyServerStatus, 'applied' | 'no-change'>,
      issues: ValidationIssue[],
      extra: Partial<RepositoryApplyResponseBody> = {},
    ) {
      return c.json<RepositoryApplyResponseBody>(
        { ok: false, status, issues, ...extra },
        HTTP_STATUS[status],
      );
    }

    /**
     * A protection or approval refusal.
     *
     * `403`, not the `422` that carries every other `invalid`. The document is
     * fine and the operations are fine — what is missing is permission, and a
     * caller told "unprocessable" would go looking for a malformed scene they
     * do not have. The `status` discriminator stays `invalid` because the
     * client's next move is the same for both: read the issues, fix, resubmit.
     */
    function refuseProtection(issues: ValidationIssue[]) {
      return c.json<RepositoryApplyResponseBody>({ ok: false, status: 'invalid', issues }, 403);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json<RepositoryApplyResponseBody>(
        {
          ok: false,
          status: 'invalid',
          issues: [issue('/', 'request body is not valid JSON', 'shape')],
        },
        400,
      );
    }

    /*
     * The entire request is proven well-formed before a single canonical byte
     * is read. A malformed request should never reach the code that loads
     * mutable state, let alone the code that writes it — and a caller whose
     * request was going to be refused anyway should not have cost a file read.
     */
    const parsed = parseRepositoryApplyRequest(raw);
    if (!parsed.ok) {
      return c.json<RepositoryApplyResponseBody>(
        { ok: false, status: 'invalid', issues: parsed.issues },
        400,
      );
    }
    const request: RepositoryApplyRequest = parsed.request;
    const actor: EditActor = request.actor;
    const operations: readonly GameObjectSceneOperation[] = request.operations;

    /*
     * An AI request may never carry an approval.
     *
     * `approval-required` exists so a *human* decides; an approval the agent
     * attaches to its own request is the agent deciding, in a field named as
     * though a human had. Refused rather than ignored: a caller that believed
     * it was approving something needs to be told it was not, and an ignored
     * field looks exactly like an honoured one from the outside.
     */
    if (actor === 'ai' && request.approval !== undefined) {
      return refuseProtection([
        issue(
          '/approval',
          'an AI actor cannot carry its own approval; a human must apply the approved change',
          'protection',
        ),
      ]);
    }

    const project = loadProject(root);

    /*
     * The revision check comes before anything else, and compares against the
     * *current* document rather than a cached one. A check performed after the
     * operations were replayed would still refuse the write, but would have
     * spent the replay deciding what to refuse — and, worse, would report
     * issues from a document nobody is going to keep.
     */
    if (request.expected.projectRevisionId !== project.revisionId) {
      return refuse('conflict', [
        issue(
          '/revisionId',
          `Apply refused: target revision changed (session opened at "${request.expected.projectRevisionId}", repository is at "${project.revisionId}")`,
          'conflict',
        ),
      ]);
    }

    if (request.target.kind !== 'scene') {
      // Structurally valid, semantically unsupported here — which is a
      // different thing from malformed, and says so.
      return c.json<RepositoryApplyResponseBody>(
        {
          ok: false,
          status: 'invalid',
          issues: [
            issue(
              '/target/kind',
              `target kind "${request.target.kind}" is not applied through this endpoint yet; character-owned and animation-asset edits keep their existing destination flow`,
              'unsupported',
            ),
          ],
        },
        400,
      );
    }

    // The server resolves the target by id from canonical data. It does not
    // trust a client-supplied label, and never an array position.
    const targetId = request.target.id;
    const index = project.scenes.findIndex((scene) => scene.id === targetId);
    if (index === -1) {
      return c.json<RepositoryApplyResponseBody>(
        {
          ok: false,
          status: 'invalid',
          issues: [issue('/target/id', `no scene "${targetId}"`, 'reference')],
        },
        404,
      );
    }

    const baseScene = project.scenes[index]!;
    let scene = baseScene;
    const changedPaths: string[] = [];
    const protectedChangedPaths: string[] = [];

    /*
     * The operation context, built from the repository rather than the request.
     *
     * `knownPrefabKeys` is what makes §8.2 enforceable server-side: a Scene may
     * only name a Prefab version this checkout actually holds, exactly, hash
     * included. `capabilities` is what lets the server refuse "make this the
     * active camera" for an object whose Prefab has no camera — a check the
     * browser also makes, and one that would be a habit of one client rather
     * than a rule if only the browser made it.
     */
    const prefabRegistry = loadPrefabRegistry(root);
    const operationContext = {
      knownPrefabKeys: new Set(
        prefabRegistry
          .all()
          .map((stored) =>
            exactPrefabReferenceKey(
              prefabRegistry.referenceTo(stored.id, stored.version),
            ),
          ),
      ),
      capabilities: prefabCapabilityLookup(prefabRegistry),
    };

    for (const [position, operation] of operations.entries()) {
      const result = applySceneGameObjectOperation(scene, operation, operationContext);
      if (!result.ok || result.document === undefined) {
        return refuse(
          'invalid',
          result.issues.map((entry) => ({
            ...entry,
            path: `/operations/${position}${entry.path}`,
          })),
        );
      }

      const touched = result.changedPaths ?? [];
      const { protectedPaths, invariantPaths } = classifyPaths(scene, touched);

      if (invariantPaths.length > 0) {
        // Not approvable, by anyone, with any reason. An invariant that a
        // sufficiently insistent caller can talk past is not an invariant.
        return refuseProtection(
          invariantPaths.map((path) =>
            issue(
              `/operations/${position}${path}`,
              resolveProtection(scene, path).reason ||
                'value is a project invariant and cannot be changed by tooling',
              'protection',
            ),
          ),
        );
      }

      if (actor === 'ai' && protectedPaths.length > 0) {
        return refuseProtection(
          protectedPaths.map((path) => {
            const { level, reason } = resolveProtection(scene, path);
            return issue(
              `/operations/${position}${path}`,
              reason ||
                (level === 'locked'
                  ? 'value is locked; a human must unlock it first'
                  : 'requires human approval before an AI change is applied'),
              level === 'approval-required' ? 'approval-required' : 'protection',
            );
          }),
        );
      }

      scene = result.document;
      changedPaths.push(...touched);
      protectedChangedPaths.push(...protectedPaths);
    }

    /*
     * The approval is compared against paths the *server* computed by replaying
     * the operations, never against anything the request declared. Exact set
     * equality, on normalized lists:
     *
     *   a missing path   — a protected value would move unapproved
     *   an extra path    — the human approved something this Apply does not do,
     *                      so the record of what they agreed to is wrong
     *   a wildcard       — cannot be exact, by construction
     *
     * A duplicate path is refused earlier, by the schema's `uniqueItems`.
     */
    const expectedApproval = normalizePaths(protectedChangedPaths);
    const approval: ProtectionApproval | undefined = request.approval;

    if (expectedApproval.length === 0) {
      if (approval !== undefined) {
        return refuseProtection([
          issue(
            '/approval',
            'this Apply changes no protected path, so it must not carry an approval; ' +
              'an approval that approves nothing records a decision that was never needed',
            'protection',
          ),
        ]);
      }
    } else {
      if (approval === undefined) {
        return refuseProtection([
          issue(
            '/approval',
            `this Apply changes protected path(s) ${expectedApproval.join(', ')} and requires an explicit human approval naming exactly those paths`,
            'approval-required',
          ),
        ]);
      }
      const approved = normalizePaths(approval.approvedPaths);
      if (!samePathSet(approved, expectedApproval)) {
        return refuseProtection([
          issue(
            '/approval/approvedPaths',
            `approval does not match the protected paths this Apply changes; approved [${approved.join(', ')}], this Apply changes [${expectedApproval.join(', ')}]`,
            'approval-mismatch',
          ),
        ]);
      }
    }

    /*
     * Which GameObjects moved, computed from the two documents.
     *
     * Not accumulated per operation: two operations that touch one object, or
     * one that places an object a later one deletes, would each contribute a
     * name to a running list that no longer describes the result. The
     * before/after comparison describes what the Apply *did*.
     */
    const changedIds = changedGameObjectIds(baseScene, scene);

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
      return refuse('invalid', issues);
    }

    /*
     * An Apply whose operations cancel out writes nothing, and says so.
     *
     * Reported as its own status rather than as `applied` with an empty change
     * list. "Applied" and "nothing happened" are different answers to "what did
     * my button do", and a UI that renders the second as the first teaches the
     * user that Apply sometimes silently does nothing — after which they stop
     * trusting the times it says it worked.
     *
     * No project write, no report, no transaction directory, no revision bump.
     * The content-derived revision is what makes this detectable at all —
     * compared against the *recomputed* revision of what is on disk, never
     * against its stored `revisionId`, which was minted by whatever wrote it
     * last.
     */
    if (proposed.revisionId === revisionOf(project)) {
      return c.json<RepositoryApplyResponseBody>({
        ok: true,
        status: 'no-change',
        issues: [],
        project,
        targetDocument: scene,
        changedPaths: [],
        changedGameObjectIds: [],
      });
    }

    const applyId = randomUUID();
    const report: RepositoryApplyReport = {
      applyId,
      target: { kind: request.target.kind, id: targetId },
      baseRevisionId: project.revisionId,
      newRevisionId: proposed.revisionId,
      actor,
      intent: request.intent,
      changedPaths,
      operations: operations.map((operation) => operation.type),
      files: [PROJECT_PATH],
      ...(approval ? { protectionApproval: approval } : {}),
    };
    const reportFile = repositoryReportFile(report);

    const writes: PlannedFileWrite[] = [
      { repositoryPath: PROJECT_PATH, mode: 'replace', content: projectContent(proposed) },
      { repositoryPath: reportFile.path, mode: 'create', content: reportFile.contents },
    ];

    // Optimistic concurrency the transaction engine re-checks under its own
    // write lock. The revision check above is the one the human reads; this is
    // the one that holds when a second writer lands between the two.
    const currentBytes = readFileSync(resolve(root, PROJECT_PATH));
    const result = await runRepositoryTransaction(
      root,
      {
        intent: request.intent,
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
        validatePreparedView: (view) =>
          validatePrepared(view, { proposed, report, reportPath: reportFile.path, targetId }),
      },
      runtime.transactionOptions,
    );

    if (!result.ok) {
      /*
       * `repository-unresolved` arrives as a `conflict-refused` because that is
       * how the lock reports a takeover it will not perform. It is not a
       * conflict: nobody can say what the previous transaction left behind, so
       * the repository needs a human rather than a reload. Reporting it as a
       * 409 would tell the one user who must stop to try again.
       */
      const unresolved = result.issues.some((entry) => entry.code === 'repository-unresolved');
      const status = unresolved ? 'repository-read-only' : outcomeForTransaction(result.state);
      if (status === 'repository-read-only') {
        markRepositoryFatal(
          runtime.health,
          result.transactionId,
          result.issues.map((entry) => entry.message).join('; '),
        );
      }
      const transactionIssues = result.issues.map((entry) =>
        issue(entry.path ?? '/', entry.message, entry.code),
      );
      return refuse(
        status,
        transactionIssues.length > 0
          ? transactionIssues
          : [issue('/', `apply transaction ${result.state}`, result.state)],
        { transactionId: result.transactionId },
      );
    }

    return c.json<RepositoryApplyResponseBody>({
      ok: true,
      status: 'applied',
      issues: [],
      project: proposed,
      targetDocument: scene,
      changedPaths,
      changedGameObjectIds: changedIds,
      reportPath: reportFile.path,
      applyId,
      transactionId: result.transactionId,
    });
  });
}

/**
 * Validates the bytes the transaction is about to promote.
 *
 * This used to be `() => ({ issues: [] })`, justified on the grounds that the
 * in-memory candidate had already been validated against the same documents.
 * That reasoning has a hole in it: what was validated is the object this
 * process holds, and what gets promoted is the bytes that were serialised,
 * written to `prepared/`, and fsynced. Those are the same thing right up until
 * they are not — a truncated write, a serialisation that dropped a field, a
 * report describing a different revision than the project beside it — and the
 * whole reason for a prepared phase is to have somewhere to catch that *before*
 * the point of no return.
 *
 * So everything here reads through `view`. Closing over `proposed` and
 * returning success would re-assert what is already known and check nothing.
 */
function validatePrepared(
  view: PreparedRepositoryView,
  context: {
    proposed: ProjectDefinition;
    report: RepositoryApplyReport;
    reportPath: string;
    targetId: string;
  },
): { issues: TransactionIssue[] } {
  const issues: TransactionIssue[] = [];
  const error = (code: string, message: string, path?: string) => {
    issues.push({ code, severity: 'error', message, ...(path ? { path } : {}) });
  };

  let prepared: ProjectDefinition;
  try {
    prepared = JSON.parse(view.readText(PROJECT_PATH)) as ProjectDefinition;
  } catch (failure) {
    error(
      'prepared-project-unreadable',
      `prepared ${PROJECT_PATH} is not readable JSON: ${failure instanceof Error ? failure.message : String(failure)}`,
      PROJECT_PATH,
    );
    // Nothing below can say anything useful about a document that did not
    // parse, and every check would report the same failure again.
    return { issues };
  }

  for (const entry of validateProject(prepared).issues) {
    error('prepared-project-invalid', `${entry.path}: ${entry.message}`, PROJECT_PATH);
  }
  for (const entry of validateProjectReferences(prepared).issues) {
    error('prepared-project-references-invalid', `${entry.path}: ${entry.message}`, PROJECT_PATH);
  }

  // The changed target, resolved from the prepared bytes by stable id — not by
  // the array position it happened to occupy when the candidate was built.
  const preparedScene = prepared.scenes?.find((entry) => entry.id === context.targetId);
  if (!preparedScene) {
    error(
      'prepared-target-missing',
      `prepared project does not contain the scene "${context.targetId}" this Apply targets`,
      PROJECT_PATH,
    );
  } else {
    /*
     * The GameObject view of the prepared Scene, not the entity view.
     *
     * This Apply wrote `gameObjects` and left `entities` exactly as it found
     * them, so validating the entity mirror here would be checking bytes this
     * transaction did not produce — and would let a mirror that was already
     * stale before the Apply refuse a write that had nothing to do with it.
     */
    for (const entry of validateSceneGameObjectReferences(preparedScene).issues) {
      error('prepared-scene-references-invalid', `${entry.path}: ${entry.message}`, PROJECT_PATH);
    }
  }

  if (prepared.revisionId !== context.proposed.revisionId) {
    error(
      'prepared-revision-mismatch',
      `prepared project carries revision "${prepared.revisionId}" but this Apply promised "${context.proposed.revisionId}"`,
      PROJECT_PATH,
    );
  }

  let preparedReport: RepositoryApplyReport;
  try {
    preparedReport = JSON.parse(view.readText(context.reportPath)) as RepositoryApplyReport;
  } catch (failure) {
    error(
      'prepared-report-unreadable',
      `prepared ${context.reportPath} is not readable JSON: ${failure instanceof Error ? failure.message : String(failure)}`,
      context.reportPath,
    );
    return { issues };
  }

  /*
   * The report and the project have to describe the same event. A report whose
   * `newRevisionId` disagrees with the project beside it is worse than no
   * report: it is the artifact someone will later use to reconstruct what
   * happened, and it would tell them a revision existed that never did.
   */
  if (preparedReport.newRevisionId !== prepared.revisionId) {
    error(
      'prepared-report-revision-mismatch',
      `prepared report names new revision "${preparedReport.newRevisionId}" but the prepared project is "${prepared.revisionId}"`,
      context.reportPath,
    );
  }
  if (preparedReport.baseRevisionId !== context.report.baseRevisionId) {
    error(
      'prepared-report-base-mismatch',
      `prepared report names base revision "${preparedReport.baseRevisionId}" but this Apply was built on "${context.report.baseRevisionId}"`,
      context.reportPath,
    );
  }
  if (preparedReport.target?.id !== context.targetId) {
    error(
      'prepared-report-target-mismatch',
      `prepared report names target "${String(preparedReport.target?.id)}" but this Apply targets "${context.targetId}"`,
      context.reportPath,
    );
  }
  if (preparedReport.applyId !== context.report.applyId) {
    error(
      'prepared-report-identity-mismatch',
      'prepared report does not carry this Apply\'s identity',
      context.reportPath,
    );
  }

  /*
   * The report must name the canonical files this transaction actually writes.
   * A report that under-claims leaves a changed file undocumented; one that
   * over-claims names a file this Apply never touched, and both make the report
   * useless for the audit it exists to serve.
   */
  const promoted = new Set(view.writtenPaths());
  for (const named of preparedReport.files ?? []) {
    if (!promoted.has(named)) {
      error(
        'prepared-report-file-unwritten',
        `prepared report names "${named}", which this transaction does not write`,
        context.reportPath,
      );
    }
  }
  if (!promoted.has(PROJECT_PATH)) {
    error(
      'prepared-project-unwritten',
      `this transaction does not write ${PROJECT_PATH}, so there is nothing for the report to describe`,
      PROJECT_PATH,
    );
  }

  return { issues };
}
