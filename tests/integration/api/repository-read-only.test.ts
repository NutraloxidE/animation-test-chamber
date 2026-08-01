/**
 * The same-process fatal lockdown, over real HTTP handlers.
 *
 * The package-level tests prove the transaction engine keeps its lock and
 * reports `fatal`. That is only half the guarantee: a running API that learned
 * nothing from it would happily accept the next POST, acquire a *new* lock and
 * write on top of a repository whose contents nobody can account for. What is
 * checked here is the other half — one request goes fatal, and the very next
 * write is refused by the same process, before a second transaction exists.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnimationAsset, ProjectDefinition, SaveAnimationChangesRequest } from '@atc/schema';
import { assetFilePath } from '@atc/schema';
import {
  AnimationAssetRegistry,
  planSaveAnimationChanges,
  resolveCharacterAnimation,
  sealAsset,
  type StoredAsset,
} from '@atc/animation-asset-runtime';
import {
  createNodeFilesystem,
  transactionRootDir,
  withFaultInjection,
  type FilesystemOps,
} from '@atc/repository-transaction';
import { createApp } from '../../../apps/api/src/app.ts';

/** The app value `createApp` hands back; `hono` itself is not resolvable from here. */
type ApiApp = ReturnType<typeof createApp>['app'];
import { createRepositoryRuntime, type RepositoryRuntime } from '../../../apps/api/src/runtime.ts';
import { loadStoredAssets } from '../../../apps/api/src/context.ts';

const SOURCE_REPO = resolve(__dirname, '../../..');
const PROJECT_PATH = 'projects/demo-character/project.json';
const CHARACTER_ID = 'demo-humanoid';
const WRITE_LOCK = 'write.lock';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-api-fatal-'));
  mkdirSync(join(repoRoot, 'projects/demo-character'), { recursive: true });
  cpSync(join(SOURCE_REPO, PROJECT_PATH), join(repoRoot, PROJECT_PATH));
  cpSync(join(SOURCE_REPO, 'assets/animation'), join(repoRoot, 'assets/animation'), {
    recursive: true,
  });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function projectOf(root: string): ProjectDefinition {
  return JSON.parse(readFileSync(join(root, PROJECT_PATH), 'utf8')) as ProjectDefinition;
}

function registryOf(root: string): AnimationAssetRegistry {
  return new AnimationAssetRegistry(loadStoredAssets(root) as StoredAsset[]);
}

/** A valid save the API would accept: one tuning change, published as a new behaviour version. */
function saveRequest(root: string): SaveAnimationChangesRequest {
  const project = projectOf(root);
  const resolved = resolveCharacterAnimation({
    registry: registryOf(root),
    project,
    characterId: CHARACTER_ID,
  }).project;
  return {
    characterId: CHARACTER_ID,
    graph: {
      patches: [{ path: '/transitions/idle-to-walk/blendDurationSec', op: 'set', value: 0.13 }],
      destination: { kind: 'shared-behavior' },
    },
    clips: { changes: [], destination: { kind: 'none' } },
    expected: {
      projectRevisionId: resolved.revisionId,
      assetReferences: [
        resolved.character.animation.behavior,
        resolved.character.animation.motionSet,
        resolved.character.animation.rig,
      ],
    },
  };
}

/** The assets the API's plan for `request` will publish, in write order. */
function plannedAssets(root: string, request: SaveAnimationChangesRequest): AnimationAsset[] {
  const plan = planSaveAnimationChanges(registryOf(root), projectOf(root), request);
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error(plan.error);
  return plan.assets;
}

function pathOf(asset: AnimationAsset): string {
  return assetFilePath(asset.metadata.assetType, asset.metadata.id, asset.metadata.version);
}

/** The canonical paths the API's plan for `request` will try to create. */
function plannedCreatePaths(root: string, request: SaveAnimationChangesRequest): string[] {
  return plannedAssets(root, request).map(pathOf);
}

/**
 * A different, *valid* asset document at the same path — what a second writer
 * publishing its own version of the same asset would leave there. Valid on
 * purpose: the repository has to stay readable after the lockdown, and a
 * deliberately corrupt file would prove that by breaking reads instead.
 */
function foreignVersionOf(asset: AnimationAsset): string {
  const foreign = sealAsset({
    ...asset,
    metadata: {
      ...asset.metadata,
      displayName: `${asset.metadata.displayName} (published by another process)`,
      contentHash: '',
    },
  } as AnimationAsset);
  return `${JSON.stringify(foreign, null, 2)}\n`;
}

/**
 * A filesystem in which one of the transaction's own create targets is
 * rewritten by somebody else after it has been promoted.
 *
 * Post-promotion verification catches the mismatch, and rollback then refuses
 * to delete the file — those bytes are not this transaction's to destroy — so
 * the outcome is `fatal` rather than a clean rollback. This is the real shape
 * of the failure, not a thrown error standing in for one.
 */
function contendingFilesystem(contendedPath: string, foreignBytes: string): FilesystemOps {
  const real = createNodeFilesystem();
  let reads = 0;
  return withFaultInjection(real, (ctx) => {
    const target = join(repoRoot, contendedPath);
    if (ctx.op !== 'readFileBytes' || ctx.path !== target) return;
    reads += 1;
    // 1st read: the prepare-phase "does this create target already exist"
    // check. 2nd: post-promotion verification. Another writer lands in between.
    if (reads === 2) writeFileSync(target, foreignBytes, 'utf8');
  });
}

interface Harness {
  app: ApiApp;
  runtime: RepositoryRuntime;
}

interface FatalHarness extends Harness {
  request: SaveAnimationChangesRequest;
  contended: string;
  foreignBytes: string;
}

/** A server one request away from a fatal transaction, and the request that causes it. */
function fatalHarness(): FatalHarness {
  const request = saveRequest(repoRoot);
  const asset = plannedAssets(repoRoot, request)[0]!;
  const contended = pathOf(asset);
  const foreignBytes = foreignVersionOf(asset);
  return {
    ...harness({ fs: contendingFilesystem(contended, foreignBytes) }),
    request,
    contended,
    foreignBytes,
  };
}

function harness(transactionOptions: { fs?: FilesystemOps } = {}): Harness {
  const runtime = createRepositoryRuntime({ repoRoot, transactionOptions });
  const { app } = createApp({ runtime });
  return { app, runtime };
}

async function post(app: ApiApp, path: string, body: unknown) {
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function transactionIds(): string[] {
  const root = transactionRootDir(repoRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((entry) => entry !== WRITE_LOCK);
}

describe('a fatal transaction locks this process out of writing, immediately', () => {
  it('refuses the next write in the same process, and keeps reads working', async () => {
    const { app, runtime, request, contended, foreignBytes } = fatalHarness();

    // Step 1: a healthy process.
    expect(runtime.health.readOnly).toBe(false);
    const healthBefore = await app.request('/api/health');
    expect(healthBefore.status).toBe(200);
    expect((await healthBefore.json()).repositoryReadOnly).toBe(false);

    const projectBefore = readFileSync(join(repoRoot, PROJECT_PATH), 'utf8');

    // Step 2: the request that goes fatal.
    const first = await post(app, '/api/animation-assets/save-destination', request);
    expect(first.status).toBe(503);
    expect(first.body.state).toBe('fatal');
    expect(typeof first.body.transactionId).toBe('string');

    // The evidence a human needs is all still there.
    expect(runtime.health.readOnly).toBe(true);
    expect(runtime.health.fatalTransactionId).toBe(first.body.transactionId);
    expect(existsSync(join(transactionRootDir(repoRoot), WRITE_LOCK))).toBe(true);
    expect(transactionIds()).toContain(first.body.transactionId as string);
    expect(readFileSync(join(repoRoot, contended), 'utf8')).toBe(foreignBytes);
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(projectBefore);

    // Step 3: a second, entirely valid write — same process, no restart.
    const transactionsAfterFirst = transactionIds();
    // The same request again — still valid against this project revision, and
    // the plan it would produce is exactly the one that was refused.
    const second = await post(app, '/api/animation-assets/save-destination', request);
    expect(second.status).toBe(503);
    expect(second.body.state).toBe('fatal');
    expect(second.body.transactionId).toBe(first.body.transactionId);

    // Refused before a transaction was started, not after one was rolled back.
    expect(transactionIds()).toEqual(transactionsAfterFirst);
    expect(readFileSync(join(repoRoot, PROJECT_PATH), 'utf8')).toBe(projectBefore);
    expect(readFileSync(join(repoRoot, contended), 'utf8')).toBe(foreignBytes);

    // Step 4: reads are still available. A repository nobody can write to is
    // exactly the one a human needs to be able to look at.
    for (const path of ['/api/health', '/api/project', '/api/resolved-project']) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
    }
    const healthAfter = await (await app.request('/api/health')).json();
    expect(healthAfter.repositoryReadOnly).toBe(true);
    expect(healthAfter.repositoryFatalTransactionId).toBe(first.body.transactionId);
    expect(String(healthAfter.repositoryReadOnlyReason)).toMatch(/rollback|promotion|restore/i);
  });

  it('blocks every write method, not just the routes that run transactions', async () => {
    const { app, request } = fatalHarness();

    expect((await post(app, '/api/animation-assets/save-destination', request)).status).toBe(503);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/api/commit', '/api/unity/export', '/api/acquisition/import']) {
        const response = await app.request(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(response.status).toBe(503);
        expect((await response.json()).state).toBe('fatal');
      }
    }
  });

  it('a new process over the same repository also starts read-only', async () => {
    const first = fatalHarness();
    const request = first.request;
    const fatal = await post(first.app, '/api/animation-assets/save-destination', request);
    expect(fatal.status).toBe(503);

    // A restart: fresh runtime, fresh app, same checkout on disk. Startup
    // recovery has to reach the same conclusion the crashed process did.
    const restarted = harness();
    expect(restarted.runtime.health.readOnly).toBe(true);
    expect(restarted.runtime.health.reason).toBeTruthy();
    // Recovery resolves what it can; it does not tidy away the lock the fatal
    // transaction is still holding.
    expect(existsSync(join(transactionRootDir(repoRoot), WRITE_LOCK))).toBe(true);

    const response = await post(restarted.app, '/api/animation-assets/save-destination', request);
    expect(response.status).toBe(503);
    expect(transactionIds().length).toBeGreaterThan(0);
    expect((await (await restarted.app.request('/api/health')).json()).repositoryReadOnly).toBe(true);
  });
});

describe('outcomes that leave the repository accountable do not lock it down', () => {
  it('a clean save keeps the process writable and lands every file', async () => {
    const { app, runtime } = harness();
    const request = saveRequest(repoRoot);
    const expected = plannedCreatePaths(repoRoot, request);

    const result = await post(app, '/api/animation-assets/save-destination', request);
    expect(result.status).toBe(200);
    expect(result.body.state).toBe('committed');
    expect(runtime.health.readOnly).toBe(false);
    for (const path of expected) {
      expect(existsSync(join(repoRoot, path))).toBe(true);
    }
    expect(existsSync(join(transactionRootDir(repoRoot), WRITE_LOCK))).toBe(false);

    // And a second save in the same process still works.
    const again = await post(app, '/api/animation-assets/save-destination', saveRequest(repoRoot));
    expect(again.status).toBe(200);
  });

  it('a refused save leaves the process writable', async () => {
    const { app, runtime } = harness();
    const stale = saveRequest(repoRoot);

    const refused = await post(app, '/api/animation-assets/save-destination', {
      ...stale,
      expected: { ...stale.expected, projectRevisionId: 'rev-that-does-not-exist' },
    });
    expect(refused.status).toBe(409);
    expect(runtime.health.readOnly).toBe(false);

    const accepted = await post(app, '/api/animation-assets/save-destination', saveRequest(repoRoot));
    expect(accepted.status).toBe(200);
  });
});
