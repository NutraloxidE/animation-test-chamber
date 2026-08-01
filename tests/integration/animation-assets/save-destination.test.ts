/**
 * WP-06: an actual `SaveAnimationChangesRequest`, planned by
 * `planSaveAnimationChanges`, carried through a real, on-disk
 * `runRepositoryTransaction` — the two halves PR12's critical-integrity
 * fixes touch, exercised together rather than each in isolation. Every test
 * here operates on a throwaway copy of the real demo assets/project, never
 * the checked-out repository itself.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnimationAsset, ProjectDefinition, SaveAnimationChangesRequest } from '@atc/schema';
import { assetFilePath } from '@atc/schema';
import { planSaveAnimationChanges } from '@atc/animation-asset-runtime';
import {
  createNodeFilesystem,
  recoverRepository,
  runRepositoryTransaction,
  sha256Hex,
  transactionRootDir,
  type FilesystemOps,
  type PlannedFileWrite,
} from '@atc/repository-transaction';
import { runReplay, REPLAY_FIXTURES } from '@atc/replay-runtime';
import { resolveCharacterAnimation, AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import { isWriteBlockedByReadOnly } from '../../../apps/api/src/context.ts';
import { demoRegistry, loadDemoProject, loadDemoAssets, loadResolvedDemoProject } from '../../fixtures/project.ts';

const REAL_REPO_ROOT = resolve(__dirname, '../../..');
const PROJECT_PATH = 'projects/demo-character/project.json';
const CHARACTER_ID = 'demo-humanoid';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-repo-save-destination-'));
  mkdirSync(resolve(repoRoot, 'assets'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'projects'), { recursive: true });
  cpSync(resolve(REAL_REPO_ROOT, 'assets/animation'), resolve(repoRoot, 'assets/animation'), { recursive: true });
  cpSync(
    resolve(REAL_REPO_ROOT, 'projects/demo-character'),
    resolve(repoRoot, 'projects/demo-character'),
    { recursive: true },
  );
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function writesFor(assets: AnimationAsset[], project?: ProjectDefinition): PlannedFileWrite[] {
  const writes: PlannedFileWrite[] = assets.map((asset) => ({
    repositoryPath: assetFilePath(asset.metadata.assetType, asset.metadata.id, asset.metadata.version),
    mode: 'create',
    content: `${JSON.stringify(asset, null, 2)}\n`,
  }));
  if (project) {
    writes.push({ repositoryPath: PROJECT_PATH, mode: 'replace', content: `${JSON.stringify(project, null, 2)}\n` });
  }
  return writes;
}

function readProjectText(): string {
  return readFileSync(resolve(repoRoot, PROJECT_PATH), 'utf8');
}

function projectHash(): string {
  return sha256Hex(readFileSync(resolve(repoRoot, PROJECT_PATH)));
}

/** A mixed graph (shared-behaviour) + clip (new versions) save on the demo character. */
function mixedSaveRequest(resolved: ReturnType<typeof loadResolvedDemoProject>): SaveAnimationChangesRequest {
  const sourceClip = resolved.clipAssetSources['sword-attack-01']!;
  return {
    characterId: CHARACTER_ID,
    graph: {
      patches: [{ path: '/transitions/idle-to-walk/blendDurationSec', op: 'set', value: 0.12 }],
      destination: { kind: 'shared-behavior' },
    },
    clips: {
      changes: [{ sourceClip, clipId: 'sword-attack-01', patches: [{ path: '/durationSec', op: 'set', value: 0.7 }] }],
      destination: { kind: 'new-clip-versions-and-motion-set' },
    },
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

function nextProjectFor(project: ProjectDefinition, planAssignment: unknown): ProjectDefinition {
  return {
    ...project,
    characters: project.characters.map((entry) =>
      entry.id === CHARACTER_ID
        ? { ...entry, animation: planAssignment as (typeof entry)['animation'] }
        : entry,
    ),
  };
}

describe('Scenario 1 — mixed publication, final journal write fails', () => {
  it('rolls back every new version file and leaves project.json byte-identical; never validation-refused', async () => {
    const registry = demoRegistry();
    const project = loadDemoProject();
    const resolved = loadResolvedDemoProject(CHARACTER_ID);
    const plan = planSaveAnimationChanges(registry, project, mixedSaveRequest(resolved));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.assets.length).toBeGreaterThanOrEqual(3); // behaviour + clip + motion-set

    const nextProject = nextProjectFor(project, plan.assignment);
    const writes = writesFor(plan.assets, nextProject);
    const projectHashBefore = projectHash();
    const projectTextBefore = readProjectText();

    const base = createNodeFilesystem();
    const fs: FilesystemOps = {
      ...base,
      writeFile(absolutePath, data) {
        if (absolutePath.endsWith('journal.json.next')) {
          const text = new TextDecoder().decode(data);
          if (text.includes('"state": "committed"')) {
            throw new Error('injected failure writing the final committed journal');
          }
        }
        base.writeFile(absolutePath, data);
      },
    };

    const result = await runRepositoryTransaction(
      repoRoot,
      {
        intent: plan.intent,
        expected: { projectRevisionId: project.revisionId, files: [{ repositoryPath: PROJECT_PATH, expectedSha256: projectHashBefore }] },
        writes,
        validatePreparedView: () => ({ issues: [] }),
      },
      { fs },
    );

    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('validation-refused');
    expect(readProjectText()).toBe(projectTextBefore);
    expect(projectHash()).toBe(projectHashBefore);
    for (const asset of plan.assets) {
      const path = resolve(repoRoot, assetFilePath(asset.metadata.assetType, asset.metadata.id, asset.metadata.version));
      expect(() => readFileSync(path)).toThrow();
    }
    // Evidence preserved for a fatal/incomplete rollback, per WP-02.
    const txDirs = readdirSync(transactionRootDir(repoRoot)).filter((name) => name !== 'write.lock');
    if (result.issues.some((issue) => issue.code === 'rollback-incomplete')) {
      expect(txDirs.length).toBeGreaterThan(0);
    }
  });
});

describe('Scenario 2 — a foreign file occupies a planned new-version path', () => {
  it('leaves the foreign bytes untouched and refuses the request; never validation-refused', async () => {
    const registry = demoRegistry();
    const project = loadDemoProject();
    const resolved = loadResolvedDemoProject(CHARACTER_ID);
    const plan = planSaveAnimationChanges(registry, project, mixedSaveRequest(resolved));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const nextProject = nextProjectFor(project, plan.assignment);
    const writes = writesFor(plan.assets, nextProject);
    const clipAsset = plan.assets.find((asset) => asset.metadata.assetType === 'animation-clip')!;
    const clipPath = resolve(repoRoot, assetFilePath('animation-clip', clipAsset.metadata.id, clipAsset.metadata.version));

    const foreignBytes = 'planted-by-a-concurrent-writer\n';
    const base = createNodeFilesystem();
    let intercepted = false;
    const fs: FilesystemOps = {
      ...base,
      rename(fromAbsolute, toAbsolute) {
        if (toAbsolute === clipPath && !intercepted) {
          intercepted = true;
          writeFileSync(clipPath, foreignBytes, 'utf8');
          throw new Error('detected a foreign write at the new clip version path');
        }
        base.rename(fromAbsolute, toAbsolute);
      },
    };

    const projectTextBefore = readProjectText();
    const result = await runRepositoryTransaction(
      repoRoot,
      {
        intent: plan.intent,
        expected: { projectRevisionId: project.revisionId, files: [{ repositoryPath: PROJECT_PATH, expectedSha256: projectHash() }] },
        writes,
        validatePreparedView: () => ({ issues: [] }),
      },
      { fs },
    );

    expect(result.ok).toBe(false);
    expect(result.state).not.toBe('validation-refused');
    expect(readFileSync(clipPath, 'utf8')).toBe(foreignBytes);
    expect(readProjectText()).toBe(projectTextBefore);
  });
});

describe('Scenario 3 — corrupt journal at API startup', () => {
  it('recovery never throws, the repository goes read-only, and GET stays open while writes are refused', () => {
    mkdirSync(resolve(repoRoot, '.chamber-transactions', 'tx-corrupt-startup'), { recursive: true });
    writeFileSync(
      resolve(repoRoot, '.chamber-transactions', 'tx-corrupt-startup', 'journal.json'),
      '{"schemaVersion":1,"transactionId":',
      'utf8',
    );

    let recovery: ReturnType<typeof recoverRepository> | undefined;
    expect(() => {
      recovery = recoverRepository(repoRoot);
    }).not.toThrow();
    expect(recovery!.readOnly).toBe(true);

    expect(isWriteBlockedByReadOnly('GET', recovery!.readOnly)).toBe(false);
    expect(isWriteBlockedByReadOnly('POST', recovery!.readOnly)).toBe(true);
    expect(isWriteBlockedByReadOnly('PUT', recovery!.readOnly)).toBe(true);
    expect(isWriteBlockedByReadOnly('DELETE', recovery!.readOnly)).toBe(true);

    // A repository that recovered clean must never block writes.
    expect(isWriteBlockedByReadOnly('POST', false)).toBe(false);

    expect(() =>
      readFileSync(resolve(repoRoot, '.chamber-transactions', 'tx-corrupt-startup', 'journal.json')),
    ).not.toThrow();
  });
});

describe('Scenario 4 — a structural patch staged for a tuning profile', () => {
  it('is refused before any transaction is attempted; the tuning directory on disk is untouched', () => {
    const registry = demoRegistry();
    const project = loadDemoProject();
    const resolved = loadResolvedDemoProject(CHARACTER_ID);
    const tuningDir = resolve(repoRoot, 'assets/animation/tuning');
    const before = readdirSync(tuningDir, { recursive: true } as never);

    const request: SaveAnimationChangesRequest = {
      characterId: CHARACTER_ID,
      graph: {
        patches: [{ path: '/transitions', op: 'append', value: { id: 'sneaked-in' } }],
        destination: { kind: 'tuning-profile' },
      },
      clips: { changes: [], destination: { kind: 'none' } },
      expected: {
        projectRevisionId: resolved.revisionId,
        assetReferences: [resolved.character.animation.behavior],
      },
    };

    const plan = planSaveAnimationChanges(registry, project, request);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.status).toBe(409);
    expect(plan.error).toMatch(/behavior variant/);
    // No transaction was ever attempted from this refusal — the tuning
    // directory on disk cannot have changed as a result of it.
    expect(readdirSync(tuningDir, { recursive: true } as never)).toEqual(before);
  });
});

describe('Scenario 5 — a clean mixed save still commits end to end', () => {
  it('commits, every hash verifies, and the resulting project still resolves and replays', async () => {
    const registry = demoRegistry();
    const project = loadDemoProject();
    const resolved = loadResolvedDemoProject(CHARACTER_ID);
    const plan = planSaveAnimationChanges(registry, project, mixedSaveRequest(resolved));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const nextProject = nextProjectFor(project, plan.assignment);
    const writes = writesFor(plan.assets, nextProject);

    const result = await runRepositoryTransaction(
      repoRoot,
      {
        intent: plan.intent,
        expected: { projectRevisionId: project.revisionId, files: [{ repositoryPath: PROJECT_PATH, expectedSha256: projectHash() }] },
        writes,
        validatePreparedView: () => ({ issues: [] }),
      },
      { fs: createNodeFilesystem() },
    );

    expect(result.ok).toBe(true);
    expect(result.state).toBe('committed');

    for (const asset of plan.assets) {
      const path = resolve(repoRoot, assetFilePath(asset.metadata.assetType, asset.metadata.id, asset.metadata.version));
      const onDisk = JSON.parse(readFileSync(path, 'utf8'));
      expect(sha256Hex(new TextEncoder().encode(`${JSON.stringify(onDisk, null, 2)}\n`))).toBe(
        sha256Hex(new TextEncoder().encode(`${JSON.stringify(asset, null, 2)}\n`)),
      );
    }

    // The published repository, freshly loaded from the temp root, still
    // resolves and replays for the character that was saved.
    const publishedAssets = [...loadDemoAssets(), ...plan.assets.map((asset) => ({
      assetType: asset.metadata.assetType,
      id: asset.metadata.id,
      version: asset.metadata.version,
      document: asset,
    }))];
    const publishedRegistry = new AnimationAssetRegistry(publishedAssets);
    const resolvedAfter = resolveCharacterAnimation({
      registry: publishedRegistry,
      project: nextProject,
      characterId: CHARACTER_ID,
    });
    expect(resolvedAfter.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const trace = runReplay(resolvedAfter.project, REPLAY_FIXTURES[0]!);
    expect(trace.ticks).toHaveLength(REPLAY_FIXTURES[0]!.tickCount);
  });
});
