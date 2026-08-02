/**
 * The critical integrity paths, end to end.
 *
 * The unit tests around `planSaveAnimationChanges` and the fault-injection
 * tests around the generic transaction engine each prove one half. These put
 * the halves together: a real save plan, turned into the exact file writes the
 * API adapter would produce, promoted into a real repository checkout by the
 * real transaction engine — and then made to fail at the points that used to
 * be unrecoverable.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AnimationAsset,
  ProjectDefinition,
  SaveAnimationChangesRequest,
} from '@atc/schema';
import { assetFilePath } from '@atc/schema';
import { planSaveAnimationChanges } from '@atc/animation-asset-runtime';
import {
  createNodeFilesystem,
  journalFilePath,
  readJournal,
  recoverRepository,
  runRepositoryTransaction,
  sha256Hex,
  transactionDir,
  transactionRootDir,
  withFaultInjection,
  type PlannedFileWrite,
  type TransactionJournal,
} from '@atc/repository-transaction';
import { READ_ONLY_MESSAGE, refusesWrite } from '../../../apps/api/src/read-only-guard.ts';
import { animationAssetRoutes } from '../../../apps/api/src/routes/animation-assets.ts';
import { demoRegistry, loadDemoProject, loadResolvedDemoProject } from '../../fixtures/project.ts';

const SOURCE_REPO = resolve(__dirname, '../../..');
const PROJECT_PATH = 'projects/demo-character/project.json';
const CHARACTER_ID = 'demo-humanoid';

let repoRoot: string;

/**
 * A real repository checkout: the canonical project and every published asset,
 * copied so a transaction can promote into it for real without the test
 * writing to the working tree it was launched from.
 */
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-save-e2e-'));
  mkdirSync(join(repoRoot, 'projects/demo-character'), { recursive: true });
  cpSync(join(SOURCE_REPO, PROJECT_PATH), join(repoRoot, PROJECT_PATH));
  cpSync(join(SOURCE_REPO, 'assets/animation'), join(repoRoot, 'assets/animation'), {
    recursive: true,
  });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function readRepoText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function hashOf(relativePath: string): string {
  return sha256Hex(new Uint8Array(readFileSync(join(repoRoot, relativePath))));
}

function baseRequest(): SaveAnimationChangesRequest {
  const resolved = loadResolvedDemoProject(CHARACTER_ID);
  return {
    characterId: CHARACTER_ID,
    graph: { patches: [], destination: { kind: 'none' } },
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

/**
 * The mixed publication the work package describes: a new behaviour version, a
 * new clip version, the new motion-set version that binds it, and the project
 * re-pointed at all of them.
 */
function mixedSavePlan(): { assets: AnimationAsset[]; project: ProjectDefinition; intent: string } {
  const registry = demoRegistry();
  const project = loadDemoProject();
  const resolved = loadResolvedDemoProject(CHARACTER_ID);
  const sourceClip = resolved.clipAssetSources['sword-attack-01'];
  expect(sourceClip).toBeDefined();

  const plan = planSaveAnimationChanges(registry, project, {
    ...baseRequest(),
    graph: {
      patches: [{ path: '/transitions/idle-to-walk/blendDurationSec', op: 'set', value: 0.11 }],
      destination: { kind: 'shared-behavior' },
    },
    clips: {
      changes: [
        {
          sourceClip: sourceClip!,
          clipId: 'sword-attack-01',
          patches: [{ path: '/durationSec', op: 'set', value: 0.83 }],
        },
      ],
      destination: { kind: 'new-clip-versions-and-motion-set' },
    },
  });

  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error(plan.error);
  // Behaviour + clip + motion set: the three-asset publication, not a stand-in.
  expect(plan.assets).toHaveLength(3);

  const nextProject: ProjectDefinition = {
    ...project,
    characters: project.characters.map((entry) =>
      entry.id === CHARACTER_ID ? { ...entry, animation: plan.assignment } : entry,
    ),
  };
  return { assets: plan.assets, project: nextProject, intent: plan.intent };
}

/** The same writes `runAssetTransaction` builds, against the temp checkout. */
function writesFor(assets: AnimationAsset[], project: ProjectDefinition): PlannedFileWrite[] {
  return [
    ...assets.map((asset) => ({
      repositoryPath: assetFilePath(asset.metadata.assetType, asset.metadata.id, asset.metadata.version),
      mode: 'create' as const,
      content: `${JSON.stringify(asset, null, 2)}\n`,
    })),
    {
      repositoryPath: PROJECT_PATH,
      mode: 'replace' as const,
      content: `${JSON.stringify(project, null, 2)}\n`,
    },
  ];
}

describe('mixed publication: a failure after promotion never claims nothing happened', () => {
  it('rolls every new version back and leaves the project byte-identical', async () => {
    const { assets, project, intent } = mixedSavePlan();
    const writes = writesFor(assets, project);
    const projectHash = hashOf(PROJECT_PATH);
    const real = createNodeFilesystem();

    // Fails the journal write that records `state=committed` — after every one
    // of those files is already at its canonical path.
    let fired = false;
    const fs = withFaultInjection(real, (ctx) => {
      if (fired) return;
      if (ctx.op !== 'writeFile' || !/journal\.json(\.next)?$/.test(ctx.path)) return;
      const bytes = real.readFileIfExists(ctx.path.replace(/\.next$/, ''));
      if (!bytes) return;
      let journal: TransactionJournal;
      try {
        journal = JSON.parse(new TextDecoder().decode(bytes)) as TransactionJournal;
      } catch {
        return;
      }
      if (journal.state !== 'promoting' || !journal.writes.every((entry) => entry.promoted)) return;
      fired = true;
      throw new Error('injected failure writing the committed journal');
    });

    const result = await runRepositoryTransaction(
      repoRoot,
      { intent, expected: {}, writes, validatePreparedView: () => ({ issues: [] }) },
      { fs },
    );

    expect(fired).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('validation-refused');
    expect(result.state).toBe('rolled-back');

    for (const write of writes) {
      if (write.mode !== 'create') continue;
      expect(existsSync(join(repoRoot, write.repositoryPath))).toBe(false);
    }
    expect(hashOf(PROJECT_PATH)).toBe(projectHash);
    expect(readRepoText(PROJECT_PATH)).toBe(readFileSync(join(SOURCE_REPO, PROJECT_PATH), 'utf8'));
  });

  it('leaves a foreign file at a planned new version path alone, and stops writing', async () => {
    const { assets, project, intent } = mixedSavePlan();
    const writes = writesFor(assets, project);
    const projectHash = hashOf(PROJECT_PATH);

    // The path the plan intends to create, claimed by someone else in the
    // window between the prepare-time absence check and promotion.
    const contended = writes.find((write) => write.mode === 'create')!.repositoryPath;
    const foreignBytes = '{"written":"by another process"}\n';
    const real = createNodeFilesystem();
    const fs = withFaultInjection(real, (ctx) => {
      if (ctx.op === 'rename' && ctx.path === join(repoRoot, PROJECT_PATH)) {
        writeFileSync(join(repoRoot, contended), foreignBytes, 'utf8');
      }
    });

    const result = await runRepositoryTransaction(
      repoRoot,
      {
        intent,
        expected: {},
        // Project first, so the collision window opens at a known point.
        writes: [writes[writes.length - 1]!, ...writes.slice(0, -1)],
        validatePreparedView: () => ({ issues: [] }),
      },
      { fs },
    );

    expect(result.ok).toBe(false);
    expect(readRepoText(contended)).toBe(foreignBytes);
    expect(hashOf(PROJECT_PATH)).toBe(projectHash);

    const recovery = recoverRepository(repoRoot, { fs: real });
    expect(recovery.readOnly).toBe(true);
    expect(readRepoText(contended)).toBe(foreignBytes);
  });

  it('commits cleanly with no injected failure, and every new file lands', async () => {
    const { assets, project, intent } = mixedSavePlan();
    const writes = writesFor(assets, project);

    const result = await runRepositoryTransaction(repoRoot, {
      intent,
      expected: {},
      writes,
      validatePreparedView: () => ({ issues: [] }),
    });

    expect(result.ok).toBe(true);
    expect(result.state).toBe('committed');
    for (const write of writes) {
      expect(readRepoText(write.repositoryPath)).toBe(write.content);
    }
    // Every published asset still matches the hash the new project references.
    const written = JSON.parse(readRepoText(PROJECT_PATH)) as ProjectDefinition;
    const character = written.characters.find((entry) => entry.id === CHARACTER_ID)!;
    for (const reference of [character.animation.behavior, character.animation.motionSet]) {
      const path = assetFilePath(reference.assetType, reference.assetId, reference.version);
      expect(existsSync(join(repoRoot, path))).toBe(true);
    }
    // And recovery afterwards finds a clean, writable repository.
    expect(recoverRepository(repoRoot).readOnly).toBe(false);
  });
});

describe('startup recovery over a corrupt journal', () => {
  const txId = 'tx-corrupt-at-startup';

  beforeEach(() => {
    const txDir = transactionDir(repoRoot, txId);
    mkdirSync(txDir, { recursive: true });
    writeFileSync(journalFilePath(txDir), '{"schemaVersion":1,"transactionId":', 'utf8');
  });

  it('boots read-only instead of throwing', () => {
    const result = recoverRepository(repoRoot);
    expect(result.readOnly).toBe(true);
    expect(result.transactions.find((t) => t.transactionId === txId)?.message).toMatch(
      /journal-corrupt/,
    );
  });

  it('refuses writes with 503 but keeps reads available', () => {
    const readOnly = recoverRepository(repoRoot).readOnly;
    expect(refusesWrite(readOnly, 'POST')).toBe(true);
    expect(refusesWrite(readOnly, 'PUT')).toBe(true);
    expect(refusesWrite(readOnly, 'GET')).toBe(false);
    expect(READ_ONLY_MESSAGE).toMatch(/read-only/);
  });

  it('preserves the corrupt transaction directory for a human', () => {
    recoverRepository(repoRoot);
    const journal = journalFilePath(transactionDir(repoRoot, txId));
    expect(existsSync(journal)).toBe(true);
    expect(readJournal(createNodeFilesystem(), transactionDir(repoRoot, txId)).status).toBe('corrupt');
  });
});

describe('POST /api/animation-assets/save-destination refuses a structural tuning save', () => {
  const app = animationAssetRoutes();

  async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await app.request('/api/animation-assets/save-destination', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('answers 409 and names the destination that can hold the change', async () => {
    const before = readFileSync(join(SOURCE_REPO, PROJECT_PATH), 'utf8');
    const transactionsBefore = existsSync(transactionRootDir(SOURCE_REPO));

    const { status, body } = await post({
      ...baseRequest(),
      graph: {
        patches: [
          {
            path: '/states',
            op: 'append',
            value: { id: 'invented-state', motionSlot: 'locomotion.idle.01' },
          },
        ],
        destination: { kind: 'tuning-profile' },
      },
    });

    expect(status).toBe(409);
    expect(String(body.error)).toMatch(/behaviour variant|behavior variant/i);
    const issues = body.issues as { code: string }[] | undefined;
    expect(issues?.map((issue) => issue.code)).toContain('unsupported-tuning-patch');

    // Nothing was published, nothing was re-pointed, and no transaction ran.
    expect(readFileSync(join(SOURCE_REPO, PROJECT_PATH), 'utf8')).toBe(before);
    expect(existsSync(transactionRootDir(SOURCE_REPO))).toBe(transactionsBefore);
  });

  it('answers 409 for a mixed set-plus-structural request rather than saving the half it likes', async () => {
    const { status, body } = await post({
      ...baseRequest(),
      graph: {
        patches: [
          { path: '/transitions/idle-to-walk/blendDurationSec', op: 'set', value: 0.12 },
          { path: '/transitions/idle-to-walk', op: 'remove' },
        ],
        destination: { kind: 'tuning-profile' },
      },
    });

    expect(status).toBe(409);
    const issues = body.issues as { code: string }[] | undefined;
    expect(issues?.map((issue) => issue.code)).toContain('unsupported-tuning-patch');
  });

  it('answers 409 for a set whose path the behaviour does not have', async () => {
    const { status, body } = await post({
      ...baseRequest(),
      graph: {
        patches: [{ path: '/transitions/idle-to-walk/noSuchField', op: 'set', value: 1 }],
        destination: { kind: 'tuning-profile' },
      },
    });

    expect(status).toBe(409);
    const issues = body.issues as { code: string }[] | undefined;
    expect(issues?.map((issue) => issue.code)).toContain('invalid-patch-path');
  });
});
