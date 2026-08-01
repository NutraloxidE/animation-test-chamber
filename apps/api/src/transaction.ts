/**
 * Animation asset transactions (PLAN, Part I §10).
 *
 * This file is a thin domain adapter now: it turns an animation-specific
 * proposal (new asset versions, an optional rewritten project) into
 * `PlannedFileWrite[]` and a validator closure, then hands both to the
 * generic, crash-safe `@atc/repository-transaction` engine, which owns the
 * journal, the write lock, promotion-by-rename and rollback. This file knows
 * nothing about *how* a transaction survives a crash — only what "valid"
 * means for animation assets.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AnimationAsset, AssetIssue, AssetIssueCode, ProjectDefinition } from '@atc/schema';
import { assetFilePath, validateProject, validateProjectReferences } from '@atc/schema';
import {
  AnimationAssetRegistry,
  assetHashMatches,
  auditRegistry,
  resolveCharacterAnimation,
  sealAsset,
  type StoredAsset,
} from '@atc/animation-asset-runtime';
import {
  runRepositoryTransaction,
  sha256Hex,
  type PlannedFileWrite,
  type PreparedRepositoryView,
  type RepositoryTransactionState,
  type TransactionIssue,
  type TransactionValidationResult,
} from '@atc/repository-transaction';
import { PROJECT_PATH, REPO_ROOT, loadProject, loadStoredAssets } from './context.ts';
import { markRepositoryFatal } from './repository-health.ts';
import type { RepositoryRuntime } from './runtime.ts';

export interface ProposedAsset {
  asset: AnimationAsset;
}

export interface TransactionRequest {
  /** Human-readable reason, recorded in the transaction journal and report. */
  intent: string;
  /** New asset versions to publish. */
  assets: AnimationAsset[];
  /** Rewritten canonical project, if the operation changes a reference. */
  project?: ProjectDefinition;
}

export interface TransactionResult {
  ok: boolean;
  transactionId: string;
  /**
   * The generic engine's own verdict, passed through unchanged. Callers need it
   * to tell a refusal that left the repository untouched apart from a `fatal`
   * one that did not — collapsing both into `ok: false` would make a repository
   * nobody can describe look like an ordinary conflict.
   */
  state: RepositoryTransactionState;
  /** Repository-relative paths that were written, on success. */
  written: string[];
  issues: AssetIssue[];
  reportPath: string;
}

/**
 * The HTTP status for a transaction outcome.
 *
 * `fatal` is 503, not 409: a conflict says "try again with fresher input", and
 * that advice is wrong here — nothing the caller changes about its request will
 * make this repository writable again before a human looks at it.
 */
export function transactionStatus(result: TransactionResult): 200 | 409 | 503 {
  if (result.ok) return 200;
  return result.state === 'fatal' ? 503 : 409;
}

function assetTypeOf(asset: AnimationAsset): StoredAsset['assetType'] {
  return asset.metadata.assetType;
}

function storedOf(asset: AnimationAsset): StoredAsset {
  return {
    assetType: assetTypeOf(asset),
    id: asset.metadata.id,
    version: asset.metadata.version,
    document: asset,
  };
}

function assetContent(asset: AnimationAsset): string {
  return `${JSON.stringify(asset, null, 2)}\n`;
}

/**
 * Validates the repository *as it would be* after the proposal lands:
 * existing assets plus the proposed ones, with every character resolved
 * against the combination. Checking the proposal in isolation would miss
 * exactly the failure that matters — a new version that is fine on its own
 * and breaks the character that references it.
 *
 * A published version being overwritten in place is no longer checked here:
 * every asset write is `mode: 'create'`, so the generic transaction engine
 * refuses it (`create-target-exists`) before this validator ever runs.
 */
export function validateProposedRepository(
  assets: readonly AnimationAsset[],
  project: ProjectDefinition,
  root: string = REPO_ROOT,
): AssetIssue[] {
  const issues: AssetIssue[] = [];

  for (const asset of assets) {
    if (!assetHashMatches(asset)) {
      issues.push({
        code: 'hash-mismatch',
        severity: 'error',
        message: `${asset.metadata.id}@${asset.metadata.version} does not match its own contentHash`,
      });
    }
  }

  const registry = new AnimationAssetRegistry([
    ...loadStoredAssets(root),
    ...assets.map(storedOf),
  ]);

  const schemaResult = validateProject(project);
  const referenceResult = validateProjectReferences(project);
  for (const issue of [...schemaResult.issues, ...referenceResult.issues]) {
    issues.push({
      code: 'schema-invalid',
      severity: 'error',
      message: `${issue.path} ${issue.message}`,
      path: issue.path,
    });
  }

  issues.push(...auditRegistry(registry, [project]));

  for (const character of project.characters) {
    const result = resolveCharacterAnimation({ registry, project, characterId: character.id });
    for (const issue of result.issues) {
      issues.push({ ...issue, message: `character "${character.id}": ${issue.message}` });
    }
  }

  return issues;
}

function toGenericIssue(issue: AssetIssue): TransactionIssue {
  return { code: issue.code, severity: issue.severity, message: issue.message, ...(issue.path ? { path: issue.path } : {}) };
}

/**
 * Runs one transaction. Never throws for a validation failure — the caller
 * needs the issue list to show the human, and an exception would lose it.
 *
 * Async because the generic engine underneath it is (crash-safe promotion
 * involves no blocking I/O primitives that would justify staying sync).
 * Every route calling this already runs inside an `async` handler.
 */
export async function runAssetTransaction(
  request: TransactionRequest,
  runtime: RepositoryRuntime,
): Promise<TransactionResult> {
  const repoRoot = runtime.repoRoot;
  const project = request.project ?? loadProject(repoRoot);

  const writes: PlannedFileWrite[] = request.assets.map((asset) => ({
    repositoryPath: assetFilePath(assetTypeOf(asset), asset.metadata.id, asset.metadata.version),
    mode: 'create',
    content: assetContent(asset),
  }));
  if (request.project) {
    writes.push({ repositoryPath: PROJECT_PATH, mode: 'replace', content: `${JSON.stringify(project, null, 2)}\n` });
  }

  // Optimistic concurrency: the project this proposal was built against must
  // still be the project on disk once the write lock is held. Computed here,
  // before the lock — the generic engine re-checks it fresh, after. Read
  // straight from disk rather than `project`, which for a rewritten proposal
  // is already the *new* revision, not the one being superseded.
  const currentProjectBytes = readFileSync(resolve(repoRoot, PROJECT_PATH));
  const expectedProjectHash = sha256Hex(new Uint8Array(currentProjectBytes));
  const currentProjectRevisionId = (JSON.parse(currentProjectBytes.toString('utf8')) as ProjectDefinition)
    .revisionId;

  // Stashed so a validation refusal can report the rich, reference-carrying
  // AssetIssue[] the rest of this codebase (and the UI) expects, rather than
  // the generic engine's stripped-down TransactionIssue[].
  let richIssues: AssetIssue[] = [];

  const result = await runRepositoryTransaction(
    repoRoot,
    {
      intent: request.intent,
      expected: {
        projectRevisionId: currentProjectRevisionId,
        files: [{ repositoryPath: PROJECT_PATH, expectedSha256: expectedProjectHash }],
      },
      writes,
      validatePreparedView(_view: PreparedRepositoryView): TransactionValidationResult {
        richIssues = validateProposedRepository(request.assets, project, repoRoot);
        return { issues: richIssues.map(toGenericIssue) };
      },
    },
    runtime.transactionOptions,
  );

  const reportPath = `reports/animation-asset-transaction-${result.transactionId}.md`;

  if (result.ok) {
    return {
      ok: true,
      transactionId: result.transactionId,
      state: result.state,
      written: result.written,
      issues: [],
      reportPath,
    };
  }

  // The one place a runtime fatal is recorded, so no route can publish a
  // 503 without the process actually having gone read-only — or, worse, stay
  // writable because the route that saw the fatal forgot to say so.
  if (result.state === 'fatal') {
    markRepositoryFatal(
      runtime.health,
      result.transactionId,
      result.issues.map((issue) => issue.message).join('; '),
    );
  }

  // Prefer the rich domain issues captured during validation; for refusals
  // that never reached the validator (path errors, lock/optimistic-concurrency
  // conflicts), fall back to the generic engine's own issues, recast as
  // AssetIssue so the response shape stays stable for existing callers.
  //
  // A fatal outcome is the exception: its validator passed, so `richIssues`
  // describes a repository that no longer exists. What the human needs is the
  // engine's account of which paths are in doubt.
  const genericIssues: AssetIssue[] = result.issues.map((issue) => ({
    code: issue.code as AssetIssueCode,
    severity: issue.severity,
    message: issue.message,
    ...(issue.path ? { path: issue.path } : {}),
  }));
  const issues: AssetIssue[] =
    result.state !== 'fatal' && richIssues.length > 0 ? richIssues : genericIssues;

  return {
    ok: false,
    transactionId: result.transactionId,
    state: result.state,
    written: [],
    issues,
    reportPath,
  };
}

/** Seals every asset in a proposal so callers cannot forget to hash one. */
export function sealAll(assets: readonly AnimationAsset[]): AnimationAsset[] {
  return assets.map((asset) => sealAsset(asset));
}
