import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameObjectPrefabAsset } from '@atc/schema';
import { prefabAssetFilePath } from '@atc/schema';
import { nextPrefabVersion, PrefabAssetRegistry } from '@atc/prefab-runtime';
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
});
