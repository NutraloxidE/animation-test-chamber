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
import type { ProjectDefinition, SceneDefinition, ValidationIssue } from '@atc/schema';
import type { RepositoryDocumentTarget, SceneOperation } from '@atc/editor-core';
import { NO_BACKEND_MESSAGE, backendAvailable } from '../backend.ts';

export type ApplyOutcome =
  | {
      status: 'applied';
      project: ProjectDefinition;
      targetDocument: SceneDefinition;
      changedPaths: string[];
      reportPath?: string;
    }
  | { status: 'conflict'; issues: ValidationIssue[] }
  | { status: 'invalid'; issues: ValidationIssue[] }
  | { status: 'unavailable'; reason: string };

export interface ApplyRequestBody {
  target: RepositoryDocumentTarget;
  expected: { projectRevisionId: string };
  operations: SceneOperation[];
  actor: 'human' | 'ai';
  intent: string;
  /** Paths the human unlocked in this session; the server refuses them from an AI. */
  unlockedPaths?: string[];
}

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

  const body = (await response.json()) as {
    ok?: boolean;
    issues?: ValidationIssue[];
    project?: ProjectDefinition;
    targetDocument?: SceneDefinition;
    changedPaths?: string[];
    reportPath?: string;
  };

  if (response.status === 409) {
    return { status: 'conflict', issues: body.issues ?? [] };
  }
  if (!response.ok || body.ok !== true || !body.project || !body.targetDocument) {
    return { status: 'invalid', issues: body.issues ?? [] };
  }

  return {
    status: 'applied',
    project: body.project,
    targetDocument: body.targetDocument,
    changedPaths: body.changedPaths ?? [],
    ...(body.reportPath ? { reportPath: body.reportPath } : {}),
  };
}
