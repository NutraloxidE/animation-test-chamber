import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnimationAsset, AssetReference, GameObjectPrefabAsset, PrefabNodeDefinition, ProjectDefinition } from '@atc/schema';
import { assetFilePath, prefabAssetFilePath, prefabHasStoredRoot } from '@atc/schema';
import { AnimationAssetRegistry, sealAsset } from '@atc/animation-asset-runtime';
import {
  createPrefabFork,
  nextPrefabVersion,
  PrefabAssetRegistry,
  describePrefabUsage,
  resolveGameObjectPrefab,
  walkResolvedNodes,
} from '@atc/prefab-runtime';
import { createApp } from '../../../apps/api/src/app.ts';
import { loadStoredAssets, loadStoredPrefabs } from '../../../apps/api/src/context.ts';
import { createRepositoryRuntime } from '../../../apps/api/src/runtime.ts';

const SOURCE_REPO = resolve(__dirname, '../../..');

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'atc-prefab-api-'));
  cpSync(join(SOURCE_REPO, 'projects'), join(repoRoot, 'projects'), { recursive: true });
  cpSync(join(SOURCE_REPO, 'assets/prefabs'), join(repoRoot, 'assets/prefabs'), {
    recursive: true,
  });
  cpSync(join(SOURCE_REPO, 'assets/animation'), join(repoRoot, 'assets/animation'), {
    recursive: true,
  });
  cpSync(
    join(SOURCE_REPO, 'generated/prefab-assets'),
    join(repoRoot, 'generated/prefab-assets'),
    { recursive: true },
  );
  cpSync(
    join(SOURCE_REPO, 'generated/animation-assets'),
    join(repoRoot, 'generated/animation-assets'),
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

function animationRegistry() {
  return new AnimationAssetRegistry(loadStoredAssets(repoRoot));
}

function animationAdoptionRequest(targetPrefabIds: string[]) {
  const currentProject = project();
  const source = currentProject.characters[0]!.animation.behavior;
  const sourceAsset = animationRegistry().get(source);
  const draft = {
    ...sourceAsset,
    metadata: {
      ...sourceAsset.metadata,
      description: `${sourceAsset.metadata.description} Published by exact adoption test.`,
    },
  } as AnimationAsset;
  const usage = describePrefabUsage({
    prefabRegistry: registry(),
    scenes: currentProject.scenes,
  });
  const holderPrefabReferences = usage
    .filter((entry) =>
      entry.animationReferences.some(
        (reference) =>
          reference.assetType === source.assetType &&
          reference.assetId === source.assetId &&
          reference.version === source.version,
      ),
    )
    .map((entry) => entry.prefab);
  return {
    source,
    draft,
    expected: {
      sourceContentHash: source.contentHash,
      projectRevisionId: currentProject.revisionId,
      holderPrefabReferences,
    },
    targetPrefabIds,
  };
}

type AssignmentSlot = 'behavior' | 'motionSet' | 'rig' | 'tuning';
type Derivation = 'base' | 'fork' | 'variant';

function animatorAssignment() {
  const resolved = resolveGameObjectPrefab(registry(), registry().referenceTo('navigator', '1.0.0')).prefab;
  const animator = walkResolvedNodes(resolved.root).flatMap((node) => node.components)
    .find((component) => component.componentType === 'animator');
  if (animator?.componentType !== 'animator') throw new Error('navigator fixture has no Animator');
  return animator.assignment;
}

function fixtureMetadata(id: string) {
  return {
    schemaVersion: 1,
    assetType: 'game-object-prefab' as const,
    id,
    version: '1.0.0',
    displayName: id,
    description: 'Adoption matrix fixture.',
    tags: ['test'],
    createdAt: '2026-08-07T00:00:00.000Z',
    createdBy: 'prefab-api-test',
    contentHash: '',
  };
}

function fixtureRoot(assignment: ReturnType<typeof animatorAssignment>, slot: AssignmentSlot): PrefabNodeDefinition {
  const unrelatedAssignment = {
    ...assignment,
    [slot]: { ...assignment[slot]!, contentHash: 'f'.repeat(64) },
    instanceOverrides: [{ path: '/graph/states/walk/speed', op: 'set' as const, value: 9 }],
  };
  return {
    nodeId: 'root',
    displayName: 'Root',
    enabled: true,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
    components: [],
    children: [{
      kind: 'inline',
      node: {
        nodeId: 'animated-child',
        displayName: 'Animated child',
        enabled: true,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
        components: [
          { schemaVersion: 1, componentId: 'unrelated-animator', componentType: 'animator', enabled: true, assignment: unrelatedAssignment },
          { schemaVersion: 1, componentId: 'target-animator', componentType: 'animator', enabled: true, assignment },
        ],
        children: [],
      },
    }],
  };
}

function storePrefab(document: GameObjectPrefabAsset): void {
  const path = join(repoRoot, prefabAssetFilePath(document.metadata.id, document.metadata.version));
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

function addMatrixFixture(derivation: Derivation, slot: AssignmentSlot): { targetId: string; source: AssetReference; oldTarget: GameObjectPrefabAsset; parentPath?: string } {
  const assignment = animatorAssignment();
  const source = assignment[slot];
  if (!source) throw new Error(`${slot} fixture reference is absent`);
  const id = `matrix-${derivation}-${slot.toLowerCase()}`;
  const root = fixtureRoot(assignment, slot);
  if (derivation === 'base') {
    const document = sealAsset({ metadata: fixtureMetadata(id), derivation: { mode: 'base' }, abstract: false, root }) as GameObjectPrefabAsset;
    storePrefab(document);
    return { targetId: id, source, oldTarget: document };
  }
  if (derivation === 'fork') {
    const origin = registry().referenceTo('default-scene-camera', '1.0.0');
    const document = sealAsset({ metadata: fixtureMetadata(id), derivation: { mode: 'fork', forkedFrom: origin, forkIntent: 'Adoption matrix fixture.' }, abstract: false, root }) as GameObjectPrefabAsset;
    storePrefab(document);
    return { targetId: id, source, oldTarget: document };
  }
  const parentId = `${id}-parent`;
  const parent = sealAsset({ metadata: fixtureMetadata(parentId), derivation: { mode: 'base' }, abstract: true, root }) as GameObjectPrefabAsset;
  storePrefab(parent);
  const parentReference = registry().referenceTo(parentId, '1.0.0');
  const document = sealAsset({
    metadata: fixtureMetadata(id),
    derivation: {
      mode: 'variant',
      parent: parentReference,
      patches: [
        { kind: 'patch-component', nodeId: 'animated-child', componentId: 'target-animator', patches: [{ path: '/enabled', op: 'set', value: true }] },
        { kind: 'patch-component', nodeId: 'animated-child', componentId: 'target-animator', patches: [{ path: `/assignment/${slot}`, op: 'set', value: source }] },
      ],
    },
    abstract: false,
  }) as GameObjectPrefabAsset;
  storePrefab(document);
  return { targetId: id, source, oldTarget: document, parentPath: prefabAssetFilePath(parentId, '1.0.0') };
}

function exactAnimationRequest(source: AssetReference, targetId: string) {
  const currentProject = project();
  const usage = describePrefabUsage({ prefabRegistry: registry(), scenes: currentProject.scenes });
  const sourceAsset = animationRegistry().get(source);
  return {
    source,
    draft: { ...sourceAsset, metadata: { ...sourceAsset.metadata, description: `${sourceAsset.metadata.description} Matrix publication.` } } as AnimationAsset,
    expected: {
      sourceContentHash: source.contentHash,
      projectRevisionId: currentProject.revisionId,
      holderPrefabReferences: usage.filter((entry) => entry.animationReferences.some((reference) =>
        reference.assetType === source.assetType && reference.assetId === source.assetId && reference.version === source.version && reference.contentHash === source.contentHash,
      )).map((entry) => entry.prefab),
    },
    targetPrefabIds: [targetId],
  };
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

describe('Animation to Prefab exact-target adoption', () => {
  it.each([
    ['base', 'behavior'], ['base', 'motionSet'], ['base', 'rig'], ['base', 'tuning'],
    ['fork', 'behavior'], ['fork', 'motionSet'], ['fork', 'rig'], ['fork', 'tuning'],
    ['variant', 'behavior'], ['variant', 'motionSet'], ['variant', 'rig'], ['variant', 'tuning'],
  ] as const)('adopts %s Ã— %s through stored files and the real resolver', async (derivation, slot) => {
    const fixture = addMatrixFixture(derivation, slot);
    const request = exactAnimationRequest(fixture.source, fixture.targetId);
    const projectBefore = readFileSync(join(repoRoot, 'projects/demo-character/project.json'), 'utf8');
    const oldAnimationPath = join(repoRoot, assetFilePath(fixture.source.assetType, fixture.source.assetId, fixture.source.version));
    const oldAnimationBytes = readFileSync(oldAnimationPath, 'utf8');
    const oldPrefabPath = join(repoRoot, prefabAssetFilePath(fixture.targetId, '1.0.0'));
    const oldPrefabBytes = readFileSync(oldPrefabPath, 'utf8');
    const parentBytes = fixture.parentPath ? readFileSync(join(repoRoot, fixture.parentPath), 'utf8') : undefined;
    const nonTargets = new Map(registry().all().filter((entry) => entry.id !== fixture.targetId).map((entry) => {
      const path = prefabAssetFilePath(entry.id, entry.version);
      return [path, readFileSync(join(repoRoot, path), 'utf8')] as const;
    }));

    const response = await api().request('/api/animation-assets/publish-and-adopt-prefabs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    const responseBody = await body(response);
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody.changedTargets).toEqual({ prefabIds: [fixture.targetId] });
    const published = responseBody.published as { animation: AssetReference; prefabs: Array<{ assetId: string; version: string; contentHash: string }> };
    const publishedPrefab = published.prefabs[0]!;
    expect(readFileSync(join(repoRoot, assetFilePath(published.animation.assetType, published.animation.assetId, published.animation.version)), 'utf8')).toContain(published.animation.contentHash);

    const nextRegistry = registry();
    const nextReference = nextRegistry.referenceTo(publishedPrefab.assetId, publishedPrefab.version);
    expect(nextReference.contentHash).toBe(publishedPrefab.contentHash);
    const resolved = resolveGameObjectPrefab(nextRegistry, nextReference).prefab;
    const targetAnimator = walkResolvedNodes(resolved.root).find((node) => node.nodeId === 'animated-child')?.components.find((component) => component.componentId === 'target-animator');
    expect(targetAnimator?.componentType).toBe('animator');
    if (targetAnimator?.componentType !== 'animator') throw new Error('target Animator did not resolve');
    expect(targetAnimator.assignment[slot]).toEqual(published.animation);
    for (const other of ['behavior', 'motionSet', 'rig', 'tuning'] as const) {
      if (other !== slot) expect(targetAnimator.assignment[other]).toEqual(animatorAssignment()[other]);
    }
    const unrelated = walkResolvedNodes(resolved.root).find((node) => node.nodeId === 'animated-child')?.components.find((component) => component.componentId === 'unrelated-animator');
    expect(unrelated?.componentType === 'animator' ? unrelated.assignment[slot] : undefined).toEqual({ ...fixture.source, contentHash: 'f'.repeat(64) });
    expect(readFileSync(oldAnimationPath, 'utf8')).toBe(oldAnimationBytes);
    expect(readFileSync(oldPrefabPath, 'utf8')).toBe(oldPrefabBytes);
    expect(readFileSync(join(repoRoot, 'projects/demo-character/project.json'), 'utf8')).toBe(projectBefore);
    if (fixture.parentPath) expect(readFileSync(join(repoRoot, fixture.parentPath), 'utf8')).toBe(parentBytes);
    for (const [path, bytes] of nonTargets) expect(readFileSync(join(repoRoot, path), 'utf8'), path).toBe(bytes);
    expect(readFileSync(join(repoRoot, 'generated/animation-assets/library-index.json'), 'utf8')).toContain(published.animation.contentHash);
    expect(readFileSync(join(repoRoot, 'generated/prefab-assets/library-index.json'), 'utf8')).toContain(publishedPrefab.contentHash);
    const stored = JSON.parse(readFileSync(join(repoRoot, prefabAssetFilePath(fixture.targetId, publishedPrefab.version)), 'utf8')) as GameObjectPrefabAsset;
    expect(stored.derivation.mode).toBe(derivation);
    if (derivation === 'variant') {
      expect('root' in stored).toBe(false);
      if (stored.derivation.mode !== 'variant') throw new Error('matrix variant changed derivation');
      const terminal = stored.derivation.patches.filter((patch) =>
        patch.kind === 'patch-component' && patch.nodeId === 'animated-child' && patch.componentId === 'target-animator' && patch.patches.some((entry) => entry.path === `/assignment/${slot}`),
      );
      expect(terminal).toHaveLength(1);
      expect(JSON.stringify(stored.derivation.patches)).toContain('/enabled');
    }
  });
  it('publishes the animation and moves zero Prefabs when the target list is empty', async () => {
    const request = animationAdoptionRequest([]);
    const prefabIndexBefore = readFileSync(
      join(repoRoot, 'generated/prefab-assets/library-index.json'),
      'utf8',
    );
    const response = await api().request('/api/animation-assets/publish-and-adopt-prefabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const responseBody = await body(response);

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody.changedTargets).toEqual({ prefabIds: [] });
    const published = (responseBody.published as { animation: {
      assetType: AnimationAsset['metadata']['assetType'];
      assetId: string;
      version: string;
      contentHash: string;
    } }).animation;
    expect(published.version).toBe('1.0.1');
    expect(
      readFileSync(
        join(repoRoot, assetFilePath(published.assetType, published.assetId, published.version)),
        'utf8',
      ),
    ).toContain(published.contentHash);
    expect(
      readFileSync(join(repoRoot, 'generated/prefab-assets/library-index.json'), 'utf8'),
    ).toBe(prefabIndexBefore);
  });

  it('publishes a real Animator reference change in exactly the named Prefab', async () => {
    const request = animationAdoptionRequest(['navigator']);
    const originalPrefabBytes = new Map(
      registry().all().map((stored) => {
        const path = prefabAssetFilePath(stored.id, stored.version);
        return [path, readFileSync(join(repoRoot, path), 'utf8')] as const;
      }),
    );
    const response = await api().request('/api/animation-assets/publish-and-adopt-prefabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const responseBody = await body(response);

    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody.changedTargets).toEqual({ prefabIds: ['navigator'] });
    const nextRegistry = registry();
    const navigator = nextRegistry.referenceTo('navigator', '1.0.1');
    const resolved = resolveGameObjectPrefab(nextRegistry, navigator).prefab;
    const animator = walkResolvedNodes(resolved.root)
      .flatMap((node) => node.components)
      .find((component) => component.componentType === 'animator');
    expect(animator?.componentType).toBe('animator');
    if (animator?.componentType !== 'animator') throw new Error('navigator must resolve an Animator');
    expect(animator.assignment.behavior).toMatchObject({
      assetId: request.source.assetId,
      version: '1.0.1',
    });
    for (const [path, bytes] of originalPrefabBytes) {
      expect(readFileSync(join(repoRoot, path), 'utf8'), path).toBe(bytes);
    }
  });

  it('refuses a stale holder snapshot with zero animation or Prefab writes', async () => {
    const request = animationAdoptionRequest(['navigator']);
    request.expected.holderPrefabReferences = [];
    const animationBefore = readdirSync(join(repoRoot, 'assets/animation'), { recursive: true }).map(String);
    const prefabsBefore = readdirSync(join(repoRoot, 'assets/prefabs'), { recursive: true }).map(String);

    const response = await api().request('/api/animation-assets/publish-and-adopt-prefabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(409);
    expect((await body(response)).changedTargets).toEqual({ prefabIds: [] });
    expect(readdirSync(join(repoRoot, 'assets/animation'), { recursive: true }).map(String)).toEqual(animationBefore);
    expect(readdirSync(join(repoRoot, 'assets/prefabs'), { recursive: true }).map(String)).toEqual(prefabsBefore);
  });
});
