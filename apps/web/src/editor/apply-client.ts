/**
 * The browser half of `Apply to Repository`.
 *
 * Three behaviours are load-bearing, and all three are about not lying to the
 * person who pressed the button (work package §9.4):
 *
 *   - on a static deployment with no API, Apply is *refused* with a precise
 *     reason. It never reports success, and it never quietly degrades into a
 *     browser-local save that looks like one;
 *   - a revision conflict is surfaced as a conflict, not as a generic failure,
 *     because the user's next move is different: reload, inspect, reapply;
 *   - a failure leaves the session's staged work untouched, so fixing one issue
 *     and applying again does not mean redoing everything.
 */
import type {
  ProjectDefinition,
  RepositoryApplyRequest,
  SceneDefinition,
  ValidationIssue,
} from '@atc/schema';
import { NO_BACKEND_MESSAGE, backendAvailable } from '../backend.ts';

/**
 * Every outcome an Apply can have, as distinct cases.
 *
 * They were previously collapsed into three — applied, conflict, invalid —
 * plus an `unchanged` flag riding on the applied case. That made the UI say
 * `APPLIED` for a request that wrote nothing, and it made "the repository has
 * gone read-only and needs a human" indistinguishable from "your scene does not
 * validate". The user's next action is different in every one of these cases,
 * which is the whole reason they are separate words.
 */
export type ApplyOutcome =
  | {
      status: 'applied';
      project: ProjectDefinition;
      targetDocument: SceneDefinition;
      changedPaths: string[];
      reportPath?: string;
      applyId?: string;
    }
  | {
      /** The operations produced the document already on disk. Nothing was written. */
      status: 'no-change';
      project: ProjectDefinition;
      targetDocument: SceneDefinition;
    }
  | { status: 'conflict'; issues: ValidationIssue[] }
  | { status: 'invalid'; issues: ValidationIssue[] }
  | { status: 'rolled-back'; issues: ValidationIssue[]; transactionId?: string }
  | { status: 'repository-read-only'; issues: ValidationIssue[]; transactionId?: string }
  | { status: 'unavailable'; reason: string };

/**
 * The request body, derived from the shared runtime schema.
 *
 * Not a browser-local restatement of the same fields. The endpoint validates
 * against that schema, so a second hand-written copy here could only ever
 * describe a request the server would refuse — and would do it silently, at the
 * one boundary where the compiler is the last check before the network.
 */
export type ApplyRequestBody = RepositoryApplyRequest;

export async function applyToRepository(request: ApplyRequestBody): Promise<ApplyOutcome> {
  if (!(await backendAvailable())) {
    return { status: 'unavailable', reason: NO_BACKEND_MESSAGE };
  }

  let response: Response;
  try {
    response = await fetch('/api/repository/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (error) {
    // A transport failure is not a validation failure. Reporting it as one
    // would send the user looking for a problem in their scene.
    return {
      status: 'unavailable',
      reason: `Could not reach the API server: ${String(error)}`,
    };
  }

  let body: {
    ok?: boolean;
    status?: ApplyOutcome['status'];
    issues?: ValidationIssue[];
    project?: ProjectDefinition;
    targetDocument?: SceneDefinition;
    changedPaths?: string[];
    reportPath?: string;
    applyId?: string;
    transactionId?: string;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // A response that is not JSON is not a validation failure either — it means
    // something between here and the endpoint answered instead of it.
    return {
      status: 'unavailable',
      reason: `The API server returned a response that was not JSON (HTTP ${response.status}).`,
    };
  }

  const issues = body.issues ?? [];

  /*
   * The server's own discriminator is authoritative. Inferring the outcome from
   * the HTTP code is what collapsed `rolled-back` and `repository-read-only`
   * into "some kind of conflict" — the status field exists precisely so the
   * client stops guessing.
   */
  switch (body.status) {
    /*
     * The two success cases additionally require a successful response and the
     * documents that prove the claim. The server only sends these with a 200,
     * so the check costs nothing when things are working — and when they are
     * not, reporting a write on a body alone is the one failure mode with no
     * recovery: the user believes their work is saved and stops keeping it.
     */
    case 'no-change':
      if (!response.ok || !body.project || !body.targetDocument) break;
      return { status: 'no-change', project: body.project, targetDocument: body.targetDocument };
    case 'conflict':
      return { status: 'conflict', issues };
    case 'rolled-back':
      return {
        status: 'rolled-back',
        issues,
        ...(body.transactionId ? { transactionId: body.transactionId } : {}),
      };
    case 'repository-read-only':
      return {
        status: 'repository-read-only',
        issues,
        ...(body.transactionId ? { transactionId: body.transactionId } : {}),
      };
    case 'applied':
      if (!response.ok || !body.project || !body.targetDocument) break;
      return {
        status: 'applied',
        project: body.project,
        targetDocument: body.targetDocument,
        changedPaths: body.changedPaths ?? [],
        ...(body.reportPath ? { reportPath: body.reportPath } : {}),
        ...(body.applyId ? { applyId: body.applyId } : {}),
      };
    default:
      break;
  }

  // No usable status, or a success status with the documents missing. Falling
  // back on the HTTP code keeps an older or mis-deployed server readable, and
  // never reports a write that cannot be proven from the response.
  if (response.status === 409) return { status: 'conflict', issues };
  if (response.status === 503) return { status: 'repository-read-only', issues };
  return { status: 'invalid', issues };
}
