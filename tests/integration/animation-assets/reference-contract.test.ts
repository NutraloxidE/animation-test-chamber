import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStoredAssets } from '../../../apps/api/src/context.ts';
import { animationAssetRoutes } from '../../../apps/api/src/routes/animation-assets.ts';

describe('loadStoredAssets: asset-path-mismatch (PLAN Part III §18)', () => {
  it('accepts a rig file whose location matches its own metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'atc-loader-ok-'));
    const dir = join(root, 'assets/animation/rigs/demo-humanoid-rig');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '1.0.0.json'),
      JSON.stringify({
        metadata: {
          schemaVersion: 2,
          assetType: 'humanoid-rig',
          id: 'demo-humanoid-rig',
          version: '1.0.0',
          displayName: 'x',
          description: 'x',
          tags: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'test',
          contentHash: '',
        },
      }),
      'utf8',
    );
    expect(() => loadStoredAssets(root)).not.toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a file whose internal metadata disagrees with where it is stored', () => {
    const root = mkdtempSync(join(tmpdir(), 'atc-loader-bad-'));
    const dir = join(root, 'assets/animation/rigs/demo-humanoid-rig');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '1.0.0.json'),
      JSON.stringify({
        metadata: {
          schemaVersion: 2,
          assetType: 'humanoid-rig',
          // Claims to be a different asset id than the directory it lives in.
          id: 'a-completely-different-rig',
          version: '1.0.0',
          displayName: 'x',
          description: 'x',
          tags: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          createdBy: 'test',
          contentHash: '',
        },
      }),
      'utf8',
    );
    expect(() => loadStoredAssets(root)).toThrow(/asset-path-mismatch/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('referenceFrom: rejects an unknown asset type before casting it (PLAN Part III §19)', () => {
  const app = animationAssetRoutes();

  it('refuses create-variant with a bogus assetType rather than casting it through', async () => {
    const response = await app.request('/api/animation-assets/create-variant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parent: { assetType: 'not-a-real-asset-type', assetId: 'x', version: '1.0.0' },
        patches: [],
        newAssetId: 'irrelevant',
        displayName: 'irrelevant',
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not an animation asset type/);
  });
});
