/**
 * Atomic asset transactions (PLAN 39).
 *
 * One asset operation touches several files: a new behaviour version, a motion
 * set that binds it, and the project reference that points at both. Half of
 * that landing is worse than none of it landing — the repository would be in a
 * state no validation run had ever seen.
 *
 * So nothing is written where the repository can see it until the *whole*
 * proposed repository has been validated: proposed files go to a staging
 * directory, the registry is built from disk-plus-proposals, every character is
 * resolved against it, and only then is anything moved into place. A failure at
 * any point deletes the staging directory and leaves published assets and the
 * project exactly as they were.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AnimationAsset, AssetIssue, ProjectDefinition } from '@atc/schema';
import { assetFilePath, validateProject, validateProjectReferences } from '@atc/schema';
import {
  AnimationAssetRegistry,
  assetHashMatches,
  auditRegistry,
  resolveCharacterAnimation,
  sealAsset,
  type StoredAsset,
} from '@atc/animation-asset-runtime';
import { PROJECT_PATH, REPO_ROOT, loadProject, loadStoredAssets } from './context.ts';

export const TRANSACTION_ROOT = '.chamber-asset-transactions';

export interface ProposedAsset {
  asset: AnimationAsset;
}

export interface TransactionRequest {
  /** Human-readable reason, recorded in the transaction report. */
  intent: string;
  /** New asset versions to publish. */
  assets: AnimationAsset[];
  /** Rewritten canonical project, if the operation changes a reference. */
  project?: ProjectDefinition;
}

export interface TransactionResult {
  ok: boolean;
  transactionId: string;
  /** Repository-relative paths that were written, on success. */
  written: string[];
  issues: AssetIssue[];
  reportPath: string;
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

/**
 * A published version is immutable (PLAN 12.3). Overwriting one would change
 * behaviour for every character already pointing at it, retroactively and
 * invisibly, which is precisely what content hashes exist to make impossible.
 */
function immutabilityIssues(assets: readonly AnimationAsset[]): AssetIssue[] {
  const issues: AssetIssue[] = [];
  for (const asset of assets) {
    const path = assetFilePath(assetTypeOf(asset), asset.metadata.id, asset.metadata.version);
    if (!existsSync(resolve(REPO_ROOT, path))) continue;
    const existing = readFileSync(resolve(REPO_ROOT, path), 'utf8');
    const proposed = `${JSON.stringify(asset, null, 2)}\n`;
    if (existing === proposed) continue;
    issues.push({
      code: 'published-asset-modified',
      severity: 'error',
      message:
        `${asset.metadata.id}@${asset.metadata.version} is already published and differs from ` +
        `this proposal. Publish a new version instead of rewriting this one.`,
      reference: {
        assetType: assetTypeOf(asset),
        assetId: asset.metadata.id,
        version: asset.metadata.version,
        contentHash: asset.metadata.contentHash,
      },
    });
  }
  return issues;
}

/**
 * Validates the repository *as it would be* after the proposal lands: existing
 * assets plus the proposed ones, with every character resolved against the
 * combination. Checking the proposal in isolation would miss exactly the
 * failure that matters — a new version that is fine on its own and breaks the
 * character that references it.
 */
export function validateProposedRepository(
  assets: readonly AnimationAsset[],
  project: ProjectDefinition,
): AssetIssue[] {
  const issues: AssetIssue[] = [...immutabilityIssues(assets)];

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
    ...loadStoredAssets(),
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

function renderReport(
  transactionId: string,
  request: TransactionRequest,
  issues: AssetIssue[],
  written: string[],
): string {
  const errors = issues.filter((issue) => issue.severity === 'error');
  const lines = [
    `# Animation asset transaction ${transactionId}`,
    '',
    `- Intent: ${request.intent}`,
    `- Outcome: ${errors.length === 0 ? 'committed' : 'rolled back'}`,
    `- Proposed assets: ${request.assets.length}`,
    `- Project rewritten: ${request.project ? 'yes' : 'no'}`,
    '',
    '## Proposed assets',
    '',
  ];
  for (const asset of request.assets) {
    lines.push(`- ${asset.metadata.assetType} \`${asset.metadata.id}@${asset.metadata.version}\``);
  }
  if (issues.length > 0) {
    lines.push('', '## Issues', '');
    for (const issue of issues) {
      lines.push(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }
  lines.push('', '## Files', '');
  if (written.length === 0) {
    lines.push('Nothing was written. Published assets and the project are untouched.');
  } else {
    for (const path of written) lines.push(`- ${path}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeFile(path: string, content: string): void {
  const full = resolve(REPO_ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

let transactionCounter = 0;

/**
 * Runs one transaction. Never throws for a validation failure — the caller
 * needs the issue list to show the human, and an exception would lose it.
 */
export function runAssetTransaction(request: TransactionRequest): TransactionResult {
  transactionCounter += 1;
  const transactionId = `tx-${Date.now().toString(36)}-${transactionCounter}`;
  const stagingDirectory = `${TRANSACTION_ROOT}/${transactionId}`;
  const reportPath = `reports/animation-asset-transaction-${transactionId}.md`;

  const originalProject = readFileSync(resolve(REPO_ROOT, PROJECT_PATH), 'utf8');
  const project = request.project ?? loadProject();

  try {
    // 1. Proposed files land in the staging directory first.
    for (const asset of request.assets) {
      writeFile(
        `${stagingDirectory}/${assetFilePath(assetTypeOf(asset), asset.metadata.id, asset.metadata.version)}`,
        `${JSON.stringify(asset, null, 2)}\n`,
      );
    }
    writeFile(
      `${stagingDirectory}/${PROJECT_PATH}`,
      `${JSON.stringify(project, null, 2)}\n`,
    );

    // 2. Validate the complete proposed repository view.
    const issues = validateProposedRepository(request.assets, project);
    if (issues.some((issue) => issue.severity === 'error')) {
      rmSync(resolve(REPO_ROOT, stagingDirectory), { recursive: true, force: true });
      writeFile(reportPath, renderReport(transactionId, request, issues, []));
      return { ok: false, transactionId, written: [], issues, reportPath };
    }

    // 3. Move into canonical paths. Only now does the repository change.
    const written: string[] = [];
    for (const asset of request.assets) {
      const path = assetFilePath(assetTypeOf(asset), asset.metadata.id, asset.metadata.version);
      writeFile(path, `${JSON.stringify(asset, null, 2)}\n`);
      written.push(path);
    }
    if (request.project) {
      writeFile(PROJECT_PATH, `${JSON.stringify(project, null, 2)}\n`);
      written.push(PROJECT_PATH);
    }

    rmSync(resolve(REPO_ROOT, stagingDirectory), { recursive: true, force: true });
    writeFile(reportPath, renderReport(transactionId, request, issues, written));
    return { ok: true, transactionId, written, issues, reportPath };
  } catch (error) {
    // Any throw is a rollback: staging goes, the project comes back byte for
    // byte, and nothing under assets/ was touched because step 3 never ran.
    rmSync(resolve(REPO_ROOT, stagingDirectory), { recursive: true, force: true });
    writeFileSync(resolve(REPO_ROOT, PROJECT_PATH), originalProject, 'utf8');
    const issues: AssetIssue[] = [
      {
        code: 'schema-invalid',
        severity: 'error',
        message: error instanceof Error ? error.message : String(error),
      },
    ];
    writeFile(reportPath, renderReport(transactionId, request, issues, []));
    return { ok: false, transactionId, written: [], issues, reportPath };
  }
}

/** Seals every asset in a proposal so callers cannot forget to hash one. */
export function sealAll(assets: readonly AnimationAsset[]): AnimationAsset[] {
  return assets.map((asset) => sealAsset(asset));
}
