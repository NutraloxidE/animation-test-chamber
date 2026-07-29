import type { CanonicalPath } from '@atc/runtime-core';

export interface CommitFile {
  path: string;
  content: string;
}

export interface CommitRequest {
  branch: string;
  /** Commit the caller believed it was building on. Required — never optional. */
  baseSha: string;
  message: string;
  body: string;
  files: CommitFile[];
}

export interface CommitResult {
  sha: string;
  branch: string;
  /** True when the branch was created by this commit. */
  createdBranch: boolean;
}

export interface PullRequestRequest {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

export interface HeadInfo {
  sha: string;
  exists: boolean;
}

/** One field both sides changed, reported per path rather than per file (PLAN 9.3). */
export interface FieldConflict {
  path: CanonicalPath;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export class GitConflictError extends Error {
  constructor(
    message: string,
    readonly expectedSha: string,
    readonly actualSha: string,
    readonly conflicts: FieldConflict[] = [],
  ) {
    super(message);
    this.name = 'GitConflictError';
  }
}

export class ProtectedBranchError extends Error {
  constructor(readonly branch: string) {
    super(`refusing to write directly to protected branch "${branch}"`);
    this.name = 'ProtectedBranchError';
  }
}

export interface GitAdapter {
  readonly kind: 'fake' | 'github';
  /** Branch that must never be written to directly. */
  readonly protectedBranch: string;
  getHead(branch: string): Promise<HeadInfo>;
  readFile(branch: string, path: string): Promise<string | null>;
  commit(request: CommitRequest): Promise<CommitResult>;
  createPullRequest(request: PullRequestRequest): Promise<PullRequestResult>;
}

/**
 * Branch naming from PLAN 3.2: one branch per tuning session, never main.
 */
export function sessionBranchName(projectId: string, sessionId: string): string {
  const safe = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  return `chamber/${safe(projectId)}/${safe(sessionId)}`;
}
