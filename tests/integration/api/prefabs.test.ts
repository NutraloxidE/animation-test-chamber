import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameObjectPrefabAsset, ProjectDefinition } from '@atc/schema';
import { prefabAssetFilePath, prefabHasStoredRoot } from '@atc/schema';
import {
  createPrefabFork,
  nextPrefabVersion,
  PrefabAssetRegistry,
} from '@atc/prefab-runtime';
import { createApp } from '../../../apps/api/src/app.ts';
import { loadStoredPrefabs } from '../../../apps/api/src/context.ts';
import { createRepositoryRuntime } from '../../../apps/api/src/runtime.ts';

const SOURCE_REPO = resolve(__dirname, '../../..');

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-prefab-api-'));
  cpSync(join(SOURCE_REPO, 'projects'), join(repoRoot, 'projects'), { recursive: true });
  cpSync(join(SOURCE_REPO, 'assets/prefabs'), join(repoRoot, 'assets/prefabs'), {
    recursive: true,
  });
  cpSync(
    join(SOURCE_REPO, 'generated/prefab-assets'),
    join(repoRoot, 'generated/prefab-assets'),
    { recursive: true },
  );
});

afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

function api() {
  return createApp({ runtime: createRepositoryRuntime({ repoRoot }) }).app;
}

function registry() {
  return new PrefabAssetRegistry(loadStoredPrefabs(repoRoot));
}

function project(): ProjectDefinition {
  return JSON.parse(
    readFileSync(join(repoRoot, 'projects/demo-character/project.json'), 'utf8'),
  ) as ProjectDefinition;
}

function prefabAdoptionRequest(targets: Array<{ sceneId: string; gameObjectId: string }>) {
  const source = registry().referenceTo('navigator', '1.0.0');
  const current = project();
  const holders = current.scenes.flatMap((scene) =>
    (scene.gameObjects ?? [])
      .filter(
        (gameObject) =>
          gameObject.prefab.assetId === source.assetId &&
          gameObject.prefab.version === source.version,
      )
      .map((gameObject) => ({
        sceneId: scene.id,
        gameObjectId: gameObject.id,
        prefab: gameObject.prefab,
      })),
  );
  return {
    source,
    expected: {
      sourceContentHash: source.contentHash,
      projectRevisionId: current.revisionId,
      sceneInstanceReferences: holders,
    },
    targets,
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('Prefab API exact identity', () => {
  it('lists and reads an exact stored Prefab version', async () => {
    const stored = registry().all()[0]!;
    const reference = registry().referenceTo(stored.id, stored.version);
    const app = api();

    const listed = await body(await app.request('/api/prefabs'));
    expect(listed.prefabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: reference.assetId,
          version: reference.version,
          contentHash: reference.contentHash,
        }),
      ]),
    );

    const response = await app.request(`/api/prefabs/${reference.assetId}/${reference.version}`);
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ reference, document: stored.document });
  });

  it('returns 404 for an unknown exact version and 409 for a pinned hash mismatch', async () => {
    const reference = registry().referenceTo(registry().all()[0]!.id, registry().all()[0]!.version);
    const app = api();

    expect((await app.request(`/api/prefabs/${reference.assetId}/999.0.0`)).status).toBe(404);
    expect(
      (
        await app.request(
          `/api/prefabs/${reference.assetId}/${reference.version}/resolve?contentHash=stale`,
        )
      ).status,
    ).toBe(409);
  });

  it('reports exact usage and delete blockers', async () => {
    const reference = registry().referenceTo('navigator', '1.0.0');
    const app = api();

    const usageResponse = await app.request(
      `/api/prefabs/${reference.assetId}/${reference.version}/usage`,
    );
    expect(usageResponse.status).toBe(200);
    const usage = await body(usageResponse);
    expect(usage.reference).toEqual(reference);
    expect(usage.sceneInstances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sceneId: 'two-humanoids-shared-animation',
          gameObjectId: 'controlled-humanoid',
        }),
        expect.objectContaining({
          sceneId: 'two-humanoids-shared-animation',
          gameObjectId: 'scripted-humanoid',
        }),
      ]),
    );

    const policyResponse = await app.request(
      `/api/prefabs/${reference.assetId}/${reference.version}/delete-policy`,
    );
    expect(policyResponse.status).toBe(200);
    const policy = await body(policyResponse);
    expect(policy.allowed).toBe(false);
    expect(policy.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'scene-instance',
          sceneId: 'two-humanoids-shared-animation',
          gameObjectId: 'controlled-humanoid',
        }),
      ]),
    );
  });
});

describe('Prefab API immutable publication', () => {
  it('publishes a new version transactionally and refuses overwriting it', async () => {
    const stored = registry().all().find((entry) => entry.document.derivation.mode === 'base')!;
    const next = nextPrefabVersion(stored.document);
    const app = api();

    const first = await app.request('/api/prefabs/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: next }),
    });
    const firstBody = await body(first);
    expect(first.status, JSON.stringify(firstBody)).toBe(200);
    const published = firstBody.published as {
      assetId: string;
      version: string;
      contentHash: string;
    };
    expect(published).toMatchObject({
      assetId: next.metadata.id,
      version: next.metadata.version,
    });

    const path = join(repoRoot, prefabAssetFilePath(published.assetId, published.version));
    const storedDocument = JSON.parse(readFileSync(path, 'utf8')) as GameObjectPrefabAsset;
    expect(storedDocument.metadata.contentHash).toBe(published.contentHash);

    const second = await app.request('/api/prefabs/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: next }),
    });
    expect(second.status).toBe(409);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(storedDocument);
  });

  it('publishes variants and forks without mutating their source lineage', async () => {
    const sourceRegistry = registry();
    const variant = sourceRegistry.get(sourceRegistry.referenceTo('navigator', '1.0.0'));
    const nextVariant = nextPrefabVersion(variant);
    const source = sourceRegistry.referenceTo('default-scene-camera', '1.0.0');
    const sourceDocument = sourceRegistry.get(source);
    expect(prefabHasStoredRoot(sourceDocument)).toBe(true);
    if (!prefabHasStoredRoot(sourceDocument)) throw new Error('camera fixture must store a root');
    const fork = createPrefabFork(
      {
        id: 'detached-camera',
        displayName: 'Detached camera',
        description: 'Integration-test fork.',
        tags: ['test'],
        createdAt: '2026-08-06T00:00:00.000Z',
        createdBy: 'prefab-api-test',
      },
      source,
      'Prove fork publication does not move its source lineage.',
      sourceDocument.root,
    );
    const beforeSource = readFileSync(
      join(repoRoot, prefabAssetFilePath(source.assetId, source.version)),
      'utf8',
    );
    const app = api();

    const variantResponse = await app.request('/api/prefabs/create-variant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: nextVariant }),
    });
    expect(variantResponse.status, JSON.stringify(await variantResponse.clone().json())).toBe(200);

    const forkResponse = await app.request('/api/prefabs/create-fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: fork }),
    });
    expect(forkResponse.status, JSON.stringify(await forkResponse.clone().json())).toBe(200);
    expect(
      readFileSync(join(repoRoot, prefabAssetFilePath(source.assetId, source.version)), 'utf8'),
    ).toBe(beforeSource);
    expect(registry().referenceTo(fork.metadata.id, fork.metadata.version)).toMatchObject({
      assetId: 'detached-camera',
      version: '1.0.0',
    });
  });
});

describe('Prefab to Scene exact-target adoption', () => {
  it('publishes only without writing the Project or moving any holder', async () => {
    const before = readFileSync(join(repoRoot, 'projects/demo-character/project.json'), 'utf8');
    const response = await api().request('/api/prefabs/publish-and-adopt-scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prefabAdoptionRequest([])),
    });
    const responseBody = await body(response);

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody.changedTargets).toEqual({ sceneInstances: [] });
    expect(responseBody.changedPaths).not.toContain('projects/demo-character/project.json');
    expect(readFileSync(join(repoRoot, 'projects/demo-character/project.json'), 'utf8')).toBe(
      before,
    );
  });

  it('moves exactly one named Scene instance and bumps the Project revision', async () => {
    const target = {
      sceneId: 'two-humanoids-shared-animation',
      gameObjectId: 'controlled-humanoid',
    };
    const before = project();
    const beforeScene = before.scenes.find((scene) => scene.id === target.sceneId)!;
    const untouchedBefore = JSON.stringify(
      beforeScene.gameObjects?.find((gameObject) => gameObject.id === 'scripted-humanoid'),
    );
    const response = await api().request('/api/prefabs/publish-and-adopt-scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prefabAdoptionRequest([target])),
    });
    const responseBody = await body(response);

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody.changedTargets).toEqual({ sceneInstances: [target] });
    const after = project();
    expect(after.revisionId).not.toBe(before.revisionId);
    const afterScene = after.scenes.find((scene) => scene.id === target.sceneId)!;
    expect(afterScene.gameObjects?.find((gameObject) => gameObject.id === target.gameObjectId)?.prefab)
      .toMatchObject({ assetId: 'navigator', version: '1.0.1' });
    expect(
      JSON.stringify(
        afterScene.gameObjects?.find((gameObject) => gameObject.id === 'scripted-humanoid'),
      ),
    ).toBe(untouchedBefore);
  });

  it.each([
    ['stale revision', (request: ReturnType<typeof prefabAdoptionRequest>) => {
      request.expected.projectRevisionId = 'stale-revision';
    }],
    ['unknown target', (request: ReturnType<typeof prefabAdoptionRequest>) => {
      request.targets = [{ sceneId: 'missing-scene', gameObjectId: 'missing-object' }];
    }],
  ])('refuses %s with zero writes', async (_name, mutate) => {
    const request = prefabAdoptionRequest([]);
    mutate(request);
    const projectBefore = readFileSync(
      join(repoRoot, 'projects/demo-character/project.json'),
      'utf8',
    );
    const prefabFilesBefore = readdirSync(join(repoRoot, 'assets/prefabs'), {
      recursive: true,
    }).map(String);

    const response = await api().request('/api/prefabs/publish-and-adopt-scenes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(409);
    expect((await body(response)).changedTargets).toEqual({ sceneInstances: [] });
    expect(readFileSync(join(repoRoot, 'projects/demo-character/project.json'), 'utf8')).toBe(
      projectBefore,
    );
    expect(
      readdirSync(join(repoRoot, 'assets/prefabs'), { recursive: true }).map(String),
    ).toEqual(prefabFilesBefore);
  });
});
