/**
 * Prefab API (§4, §5, §7).
 *
 * Every route here names an **exact** Prefab version — id *and* version — and
 * several also check the content hash. That is not ceremony. A read endpoint
 * that resolved "latest" would answer a question nobody asked: the client is
 * looking at `navigator@1.0.0` because a Scene stands on it, and a response
 * describing `1.0.2` is a description of a different document dressed as an
 * answer about this one.
 *
 * The write routes re-run the full validation chain server-side. The browser has
 * already checked and its answer is worth nothing here: a client that skipped
 * its checks — or a `curl` that never had any — must still be unable to publish
 * a broken Prefab or overwrite a published version.
 *
 * ## Publishing is not adoption
 *
 * `POST /api/prefabs/publish` creates a version and moves *nothing*. Nothing
 * that already stands on the old version starts standing on the new one. The two
 * adoption endpoints do that, and they do it against an enumerated target list —
 * never a scope. §6.2 and §17.4 forbid `all`, `shared`, `allHolders`, `scope`
 * and `updateScope` by name, and the reason is that a scope is a *description*
 * the server re-evaluates against whatever it happens to see, while an id list
 * is the decision a human actually approved. "All current holders" stays a
 * button in the UI; what goes on the wire is what that button expanded to.
 */
import type { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AnimationAsset,
  AssetReference,
  GameObjectComponentDefinition,
  GameObjectPrefabAsset,
  GameObjectPrefabReference,
  ProjectDefinition,
  PublishAnimationAndUpdatePrefabsRequest,
  PublishPrefabAndUpdateInstancesRequest,
  PrefabNodeDefinition,
  SceneDefinition,
} from '@atc/schema';
import { assetFilePath, bumpAssetVersion, prefabAssetFilePath, prefabHasStoredRoot, referencesEqual, validateAgainst } from '@atc/schema';
import {
  buildPrefabLibraryIndex,
  checkPrefabDeletePolicy,
  describePrefabUsage,
  directDependencies,
  nextPrefabVersion,
  planAnimationAdoption,
  planPrefabAdoption,
  PrefabAssetRegistry,
  referenceOf,
  resolveGameObjectPrefab,
  validatePrefabDocument,
  walkResolvedNodes,
  type PrefabIssue,
} from '@atc/prefab-runtime';
import { computeContentHash, sealAsset } from '@atc/animation-asset-runtime';
import { AnimationAssetRegistry, buildLibraryIndex } from '@atc/animation-asset-runtime';
import {
  loadPrefabRegistry,
  loadProject as loadProjectFrom,
  loadStoredAssets,
  loadStoredPrefabs,
  PREFAB_LIBRARY_INDEX_PATH,
  PROJECT_PATH,
} from '../context.ts';
import { runRepositoryTransaction, sha256Hex } from '@atc/repository-transaction';
import type { PlannedFileWrite } from '@atc/repository-transaction';
import { markRepositoryFatal } from '../repository-health.ts';
import { createRepositoryRuntime, type RepositoryRuntime } from '../runtime.ts';
import { revisionOf } from './repository-apply.ts';

const ANIMATION_LIBRARY_INDEX_PATH = 'generated/animation-assets/library-index.json';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Hono context, as the shared `publish` helper needs it.
 *
 * Narrowed by hand to the two members it uses rather than imported: Hono's
 * `Context` is generic over the app's env and variables, and threading those
 * through a local helper would tie this file to a type parameter it has no
 * opinion about.
 */
interface PrefabRouteContext {
  req: { json: () => Promise<unknown> };
  json: (body: unknown, status?: number) => Response;
}

/**
 * The reference a route's path parameters name.
 *
 * The hash comes from the registry rather than from the URL: a hash in a path
 * segment would make every link in the UI break on republication, and the
 * *identity* check that matters — "is the client looking at the version it
 * thinks it is" — belongs on the write routes, where a stale view can do damage.
 */
function referenceFrom(
  registry: PrefabAssetRegistry,
  assetId: string,
  version: string,
): GameObjectPrefabReference | undefined {
  if (!registry.versionsOf(assetId).includes(version)) return undefined;
  return registry.referenceTo(assetId, version);
}

function scenesOf(project: ProjectDefinition): SceneDefinition[] {
  return [...project.scenes];
}

/** Serialised exactly as `assets/prefabs/<id>/<version>.json` holds it. */
function prefabContent(document: GameObjectPrefabAsset): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function libraryIndexContent(registry: PrefabAssetRegistry): string {
  return `${JSON.stringify(buildPrefabLibraryIndex(registry), null, 2)}\n`;
}

function projectContent(project: ProjectDefinition): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

/**
 * A registry with extra versions layered on top of what is on disk.
 *
 * Used to validate a *proposed* publication against the repository it would
 * join — a variant whose parent is being published in the same transaction has
 * to resolve, and it cannot resolve against a registry that has not seen the
 * parent yet.
 */
function registryWith(
  root: string,
  additions: readonly GameObjectPrefabAsset[],
): PrefabAssetRegistry {
  const registry = new PrefabAssetRegistry(loadStoredPrefabs(root));
  for (const document of additions) {
    registry.add({
      id: document.metadata.id,
      version: document.metadata.version,
      document,
    });
  }
  return registry;
}

interface PublishOutcome {
  ok: boolean;
  status: 200 | 409 | 422 | 503;
  body: Record<string, unknown>;
}

function animationSchemaName(assetType: AssetReference['assetType']) {
  return {
    'animation-behavior': 'AnimationBehaviorAsset',
    'animation-motion-set': 'AnimationMotionSetAsset',
    'animation-clip': 'AnimationClipAsset',
    'humanoid-rig': 'HumanoidRigProfileAsset',
    'animation-tuning': 'AnimationTuningProfileAsset',
  }[assetType] as
    | 'AnimationBehaviorAsset'
    | 'AnimationMotionSetAsset'
    | 'AnimationClipAsset'
    | 'HumanoidRigProfileAsset'
    | 'AnimationTuningProfileAsset';
}

function assignmentPath(
  component: Extract<GameObjectComponentDefinition, { componentType: 'animator' }>,
  source: AssetReference,
): string | undefined {
  for (const key of ['behavior', 'motionSet', 'rig', 'tuning'] as const) {
    const reference = component.assignment[key];
    if (reference && referencesEqual(reference, source)) return `/assignment/${key}`;
  }
  return undefined;
}

function adoptInStoredNode(
  node: PrefabNodeDefinition,
  source: AssetReference,
  published: AssetReference,
): PrefabNodeDefinition {
  return {
    ...node,
    components: node.components.map((component) => {
      if (component.componentType !== 'animator') return component;
      const path = assignmentPath(component, source);
      if (!path) return component;
      const key = path.slice('/assignment/'.length) as 'behavior' | 'motionSet' | 'rig' | 'tuning';
      return {
        ...component,
        assignment: { ...component.assignment, [key]: published },
      } as GameObjectComponentDefinition;
    }),
    children: node.children.map((child) =>
      child.kind === 'inline'
        ? { ...child, node: adoptInStoredNode(child.node, source, published) }
        : child,
    ),
  };
}

/** Publish a new version of one holder that actually points at `published`. */
function adoptAnimationInPrefab(input: {
  registry: PrefabAssetRegistry;
  current: GameObjectPrefabAsset;
  source: AssetReference;
  published: AssetReference;
}): GameObjectPrefabAsset {
  const { registry, current, source, published } = input;
  if (current.derivation.mode === 'variant') {
    const resolved = resolveGameObjectPrefab(registry, referenceOf(current)).prefab;
    const patches = walkResolvedNodes(resolved.root).flatMap((node) =>
      node.components.flatMap((component) => {
        if (component.componentType !== 'animator') return [];
        const path = assignmentPath(component, source);
        return path
          ? [{
              kind: 'patch-component' as const,
              nodeId: node.nodeId,
              componentId: component.componentId,
              patches: [{ path, op: 'set' as const, value: published }],
            }]
          : [];
      }),
    );
    return nextPrefabVersion({
      ...current,
      derivation: { ...current.derivation, patches: [...current.derivation.patches, ...patches] },
    });
  }
  if (!prefabHasStoredRoot(current)) throw new Error('non-variant Prefab must store a root');
  return nextPrefabVersion({
    ...current,
    root: adoptInStoredNode(current.root, source, published),
  });
}

/**
 * One publication, through the shared repository transaction engine.
 *
 * Everything a publication writes goes in one transaction: the Prefab files,
 * the regenerated library index, and — for an adoption — the project. Two
 * sequential writes are two outcomes, and the pair that survives a failure
 * between them is a repository whose index does not describe its assets.
 */
async function publishThroughTransaction(input: {
  runtime: RepositoryRuntime;
  intent: string;
  documents: readonly GameObjectPrefabAsset[];
  animationAssets?: readonly AnimationAsset[];
  expectedPaths?: readonly string[];
  project?: ProjectDefinition;
  expectedProjectRevisionId?: string;
}): Promise<PublishOutcome> {
  const root = input.runtime.repoRoot;
  const writes: PlannedFileWrite[] = [];

  for (const asset of input.animationAssets ?? []) {
    writes.push({
      repositoryPath: assetFilePath(
        asset.metadata.assetType,
        asset.metadata.id,
        asset.metadata.version,
      ),
      mode: 'create',
      content: `${JSON.stringify(asset, null, 2)}\n`,
    });
  }

  if ((input.animationAssets?.length ?? 0) > 0) {
    const registry = new AnimationAssetRegistry([
      ...loadStoredAssets(root),
      ...input.animationAssets!.map((document) => ({
        assetType: document.metadata.assetType,
        id: document.metadata.id,
        version: document.metadata.version,
        document,
      })),
    ]);
    writes.push({
      repositoryPath: ANIMATION_LIBRARY_INDEX_PATH,
      mode: 'replace',
      content: `${JSON.stringify(buildLibraryIndex(registry), null, 2)}\n`,
    });
  }

  for (const document of input.documents) {
    const path = prefabAssetFilePath(document.metadata.id, document.metadata.version);
    /*
     * `create`, never `replace`. A published version is immutable (§5.1): a
     * publication that could overwrite one would silently change what every
     * existing reference to it means, and the content hash those references
     * carry would stop matching the bytes on disk.
     */
    writes.push({ repositoryPath: path, mode: 'create', content: prefabContent(document) });
  }

  if (input.documents.length > 0) {
    const nextRegistry = registryWith(root, input.documents);
    writes.push({
      repositoryPath: PREFAB_LIBRARY_INDEX_PATH,
      mode: 'replace',
      content: libraryIndexContent(nextRegistry),
    });
  }

  if (input.project) {
    writes.push({
      repositoryPath: PROJECT_PATH,
      mode: 'replace',
      content: projectContent(input.project),
    });
  }

  const expectedFiles = [
    ...(input.project
      ? [
        {
          repositoryPath: PROJECT_PATH,
          expectedSha256: sha256Hex(
            new Uint8Array(
              // The bytes the caller's snapshot was taken from. A second writer
              // landing between the read and the write is caught here.
              await import('node:fs').then((fs) =>
                fs.readFileSync(`${root}/${PROJECT_PATH}`),
              ),
            ),
          ),
        },
      ]
      : []),
    ...(input.expectedPaths ?? []).map((repositoryPath) => ({
      repositoryPath,
      expectedSha256: sha256Hex(
        new Uint8Array(
          // These exact immutable versions are what the holder plan inspected.
          // Re-check their bytes under the transaction lock.
          readFileSync(resolve(root, repositoryPath)),
        ),
      ),
    })),
  ];

  const result = await runRepositoryTransaction(
    root,
    {
      intent: input.intent,
      expected: {
        ...(input.expectedProjectRevisionId
          ? { projectRevisionId: input.expectedProjectRevisionId }
          : {}),
        files: expectedFiles,
      },
      writes,
      /*
       * The prepared bytes are validated, not the in-memory documents. What was
       * checked above is the object this process holds; what gets promoted is
       * what was serialised, written and fsynced, and the whole reason for a
       * prepared phase is to have somewhere to catch the difference.
       */
      validatePreparedView: (view) => {
        const issues = [];
        for (const document of input.documents) {
          const path = prefabAssetFilePath(document.metadata.id, document.metadata.version);
          try {
            const prepared = JSON.parse(view.readText(path)) as GameObjectPrefabAsset;
            if (prepared.metadata.contentHash !== document.metadata.contentHash) {
              issues.push({
                code: 'prepared-prefab-hash-mismatch',
                severity: 'error' as const,
                message: `prepared ${path} carries a different content hash than this publish promised`,
                path,
              });
            }
          } catch (failure) {
            issues.push({
              code: 'prepared-prefab-unreadable',
              severity: 'error' as const,
              message: `prepared ${path} is not readable JSON: ${message(failure)}`,
              path,
            });
          }
        }
        for (const asset of input.animationAssets ?? []) {
          const path = assetFilePath(
            asset.metadata.assetType,
            asset.metadata.id,
            asset.metadata.version,
          );
          try {
            const prepared = JSON.parse(view.readText(path)) as AnimationAsset;
            if (prepared.metadata.contentHash !== asset.metadata.contentHash) {
              issues.push({
                code: 'prepared-animation-hash-mismatch',
                severity: 'error' as const,
                message: `prepared ${path} carries a different content hash`,
                path,
              });
            }
          } catch (failure) {
            issues.push({
              code: 'prepared-animation-unreadable',
              severity: 'error' as const,
              message: `prepared ${path} is not readable JSON: ${message(failure)}`,
              path,
            });
          }
        }
        return { issues };
      },
    },
    input.runtime.transactionOptions,
  );

  if (!result.ok) {
    const fatal = result.state === 'fatal';
    if (fatal) {
      markRepositoryFatal(
        input.runtime.health,
        result.transactionId,
        result.issues.map((entry) => entry.message).join('; '),
      );
    }
    return {
      ok: false,
      status: fatal ? 503 : 409,
      body: {
        ok: false,
        issues: result.issues.map((entry) => ({
          path: entry.path ?? '/',
          message: entry.message,
          keyword: entry.code,
        })),
        transactionId: result.transactionId,
      },
    };
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      changedPaths: result.written,
      transactionId: result.transactionId,
    },
  };
}

export function prefabRoutes(app: Hono, runtime: RepositoryRuntime = createRepositoryRuntime()): void {
  const root = runtime.repoRoot;

  /* ---------------------------------------------------------------------- */
  /* Read (§4)                                                              */
  /* ---------------------------------------------------------------------- */

  app.get('/api/prefabs', (c) => {
    const registry = loadPrefabRegistry(root);
    const project = loadProjectFrom(root);
    const usage = describePrefabUsage({ prefabRegistry: registry, scenes: scenesOf(project) });

    return c.json({
      prefabs: registry.all().map((stored) => {
        const reference = registry.referenceTo(stored.id, stored.version);
        const entry = usage.find(
          (candidate) =>
            candidate.prefab.assetId === stored.id && candidate.prefab.version === stored.version,
        );
        return {
          // Exact identity on every row, so a caller never has to ask twice.
          assetId: reference.assetId,
          version: reference.version,
          contentHash: reference.contentHash,
          displayName: stored.document.metadata.displayName,
          derivation: stored.document.derivation.mode,
          abstract: stored.document.abstract,
          sceneInstanceCount: entry?.sceneInstances.length ?? 0,
          nestedByCount: entry?.nestedBy.length ?? 0,
        };
      }),
    });
  });

  app.get('/api/prefabs/:assetId/:version', (c) => {
    const registry = loadPrefabRegistry(root);
    const reference = referenceFrom(registry, c.req.param('assetId'), c.req.param('version'));
    if (!reference) {
      return c.json(
        { ok: false, issues: [{ path: '/', message: 'no such Prefab version', keyword: 'reference' }] },
        404,
      );
    }
    const document = registry.get(reference);
    return c.json({
      reference,
      document,
      derivation: document.derivation,
      parent: 'parent' in document.derivation ? document.derivation.parent : null,
      dependencies: directDependencies(document),
    });
  });

  app.get('/api/prefabs/:assetId/:version/resolve', (c) => {
    const registry = loadPrefabRegistry(root);
    const reference = referenceFrom(registry, c.req.param('assetId'), c.req.param('version'));
    if (!reference) {
      return c.json(
        { ok: false, issues: [{ path: '/', message: 'no such Prefab version', keyword: 'reference' }] },
        404,
      );
    }

    /*
     * A caller may pin the hash it believes it is resolving. A mismatch is a
     * refusal rather than a silently-different answer: the client is looking at
     * a page it drew from an older document, and resolving the newer one under
     * the same identity is how a stale view becomes an authoritative-looking one.
     */
    const expected = c.req.query('contentHash');
    if (expected !== undefined && expected !== reference.contentHash) {
      return c.json(
        {
          ok: false,
          issues: [
            {
              path: '/contentHash',
              message:
                `${reference.assetId}@${reference.version} has content hash ` +
                `"${reference.contentHash}", not "${expected}"`,
              keyword: 'identity',
            },
          ],
        },
        409,
      );
    }

    const resolution = resolveGameObjectPrefab(registry, reference);
    return c.json({
      reference,
      resolved: resolution.prefab,
      nodes: walkResolvedNodes(resolution.prefab.root).map((node) => ({
        nodeId: node.nodeId,
        nodePath: node.nodePath,
        displayName: node.displayName,
        nested: node.nested,
        sourcePrefab: node.sourcePrefab,
        components: node.components.map((component) => ({
          componentId: component.componentId,
          componentType: component.componentType,
        })),
      })),
      issues: resolution.issues,
    });
  });

  app.get('/api/prefabs/:assetId/:version/usage', (c) => {
    const registry = loadPrefabRegistry(root);
    const reference = referenceFrom(registry, c.req.param('assetId'), c.req.param('version'));
    if (!reference) {
      return c.json(
        { ok: false, issues: [{ path: '/', message: 'no such Prefab version', keyword: 'reference' }] },
        404,
      );
    }
    const project = loadProjectFrom(root);
    const usage = describePrefabUsage({ prefabRegistry: registry, scenes: scenesOf(project) });
    const entry = usage.find(
      (candidate) =>
        candidate.prefab.assetId === reference.assetId &&
        candidate.prefab.version === reference.version,
    );
    return c.json({
      reference,
      sceneInstances: entry?.sceneInstances ?? [],
      nestedBy: entry?.nestedBy ?? [],
      variantChildren: entry?.variantChildren ?? [],
      nestedPrefabs: entry?.nestedPrefabs ?? [],
      animationReferences: entry?.animationReferences ?? [],
      modelAssetPaths: entry?.modelAssetPaths ?? [],
    });
  });

  app.get('/api/prefabs/:assetId/:version/delete-policy', (c) => {
    const registry = loadPrefabRegistry(root);
    const reference = referenceFrom(registry, c.req.param('assetId'), c.req.param('version'));
    if (!reference) {
      return c.json(
        { ok: false, issues: [{ path: '/', message: 'no such Prefab version', keyword: 'reference' }] },
        404,
      );
    }
    const project = loadProjectFrom(root);
    return c.json(
      checkPrefabDeletePolicy({ registry, reference, scenes: scenesOf(project) }),
    );
  });

  /* ---------------------------------------------------------------------- */
  /* Validate and publish (§5)                                              */
  /* ---------------------------------------------------------------------- */

  app.post('/api/prefabs/validate', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, issues: [{ path: '/', message: 'body is not valid JSON', keyword: 'shape' }] }, 400);
    }
    const document = (body as { document?: GameObjectPrefabAsset }).document;
    if (!document) {
      return c.json({ ok: false, issues: [{ path: '/document', message: 'document is required', keyword: 'shape' }] }, 400);
    }
    const registry = loadPrefabRegistry(root);
    /*
     * Two halves, because they answer different questions. `validatePrefabDocument`
     * checks what one document can be wrong about by itself; resolution checks
     * what it can only be wrong about in the repository it would join — a parent
     * that is not there, a nested cycle, a patch with no target.
     */
    const documentIssues = validatePrefabDocument(document);
    const proposed = registryWith(root, [document]);
    const resolution = resolveGameObjectPrefab(proposed, referenceOf(document as GameObjectPrefabAsset));
    const issues = [...documentIssues, ...resolution.issues];
    void registry;
    return c.json({
      ok: !issues.some((issue) => issue.severity === 'error'),
      issues,
    });
  });

  /**
   * Publish a base Prefab, a variant or a fork.
   *
   * One route rather than three, because the three differ only in the
   * `derivation` the submitted document carries — and that is a property of the
   * document, which the validator already checks. Three routes would be three
   * places for the immutability rule to be forgotten.
   */
  async function publish(c: PrefabRouteContext, kind: 'base' | 'variant' | 'fork') {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, issues: [{ path: '/', message: 'body is not valid JSON', keyword: 'shape' }] }, 400);
    }

    const document = body.document as GameObjectPrefabAsset | undefined;
    if (!document) {
      return c.json({ ok: false, issues: [{ path: '/document', message: 'document is required', keyword: 'shape' }] }, 400);
    }
    if (document.derivation?.mode !== kind) {
      return c.json(
        {
          ok: false,
          issues: [
            {
              path: '/document/derivation/mode',
              message: `this endpoint publishes "${kind}" Prefabs; the document says "${String(document.derivation?.mode)}"`,
              keyword: 'unsupported',
            },
          ],
        },
        400,
      );
    }

    const registry = loadPrefabRegistry(root);
    const reference = referenceOf(document);

    // Immutability, checked before anything is written (§5.1). The transaction's
    // `create` mode would refuse too; refusing here says *why*.
    if (registry.versionsOf(document.metadata.id).includes(document.metadata.version)) {
      return c.json(
        {
          ok: false,
          issues: [
            {
              path: '/document/metadata/version',
              message:
                `${reference.assetId}@${reference.version} is already published and is immutable; ` +
                `publish ${nextPrefabVersion(registry.get(reference)).metadata.version} instead`,
              keyword: 'immutable',
            },
          ],
        },
        409,
      );
    }

    // Sealed here, so the stored hash is always the hash of the stored bytes.
    const sealed = sealAsset({
      ...document,
      metadata: { ...document.metadata, contentHash: '' },
    } as unknown as GameObjectPrefabAsset) as GameObjectPrefabAsset;

    const schema = validateAgainst(
      kind === 'base'
        ? 'BaseGameObjectPrefabAsset'
        : kind === 'variant'
          ? 'VariantGameObjectPrefabAsset'
          : 'ForkGameObjectPrefabAsset',
      sealed,
    );
    if (!schema.valid) return c.json({ ok: false, issues: schema.issues }, 422);

    const proposed = registryWith(root, [sealed]);
    const errors = validatePrefabDocument(sealed).filter(
      (issue: PrefabIssue) => issue.severity === 'error',
    );
    if (errors.length > 0) {
      return c.json(
        {
          ok: false,
          issues: errors.map((issue) => ({
            path: issue.path ?? '/',
            message: issue.message,
            keyword: issue.code,
          })),
        },
        422,
      );
    }
    // A published Prefab must also *resolve*: nested cycles and variant-parent
    // cycles are only visible once the graph is walked.
    const resolution = resolveGameObjectPrefab(proposed, referenceOf(sealed));
    const resolveErrors = resolution.issues.filter((issue) => issue.severity === 'error');
    if (resolveErrors.length > 0) {
      return c.json(
        {
          ok: false,
          issues: resolveErrors.map((issue) => ({
            path: issue.path ?? '/',
            message: issue.message,
            keyword: issue.code,
          })),
        },
        422,
      );
    }

    const outcome = await publishThroughTransaction({
      runtime,
      intent: `publish ${kind} Prefab ${sealed.metadata.id}@${sealed.metadata.version}`,
      documents: [sealed],
    });

    return c.json(
      {
        ...outcome.body,
        published: outcome.ok
          ? {
              assetId: sealed.metadata.id,
              version: sealed.metadata.version,
              contentHash: sealed.metadata.contentHash,
            }
          : undefined,
      },
      outcome.status,
    );
  }

  app.post('/api/prefabs/publish', (c) => publish(c, 'base'));
  app.post('/api/prefabs/create-variant', (c) => publish(c, 'variant'));
  app.post('/api/prefabs/create-fork', (c) => publish(c, 'fork'));

  /* ---------------------------------------------------------------------- */
  /* Exact-target adoption (§6, §7)                                         */
  /* ---------------------------------------------------------------------- */

  app.post('/api/animation-assets/publish-and-adopt-prefabs', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, issues: [{ path: '/', message: 'body is not valid JSON', keyword: 'shape' }] }, 400);
    }

    const parsed = validateAgainst('PublishAnimationAndUpdatePrefabsRequest', body);
    if (!parsed.valid) return c.json({ ok: false, issues: parsed.issues }, 400);
    const request = body as PublishAnimationAndUpdatePrefabsRequest;

    const registry = loadPrefabRegistry(root);
    const animationRegistry = new AnimationAssetRegistry(loadStoredAssets(root));
    const project = loadProjectFrom(root);
    const usage = describePrefabUsage({ prefabRegistry: registry, scenes: scenesOf(project) });

    /*
     * The plan is computed from the *request object*, by the same pure function
     * the confirmation dialog renders from. That is what makes "what the human
     * saw" and "what the server does" equal by construction rather than by
     * review (§8.4).
     */
    const plan = planAnimationAdoption({
      usage,
      request,
      currentProjectRevisionId: project.revisionId,
    });
    if (plan.conflicts.length > 0) {
      return c.json(
        {
          ok: false,
          issues: plan.conflicts.map((conflict) => ({
            path: '/expected',
            message: conflict.message,
            keyword: conflict.code,
          })),
          changedTargets: { prefabIds: [] },
        },
        409,
      );
    }

    const sourceIssues = animationRegistry.checkReference(request.source);
    if (sourceIssues.length > 0) {
      return c.json(
        { ok: false, issues: sourceIssues, changedTargets: { prefabIds: [] } },
        409,
      );
    }
    if (
      request.draft.metadata.assetType !== request.source.assetType ||
      request.draft.metadata.id !== request.source.assetId
    ) {
      return c.json(
        {
          ok: false,
          issues: [{
            path: '/draft/metadata',
            message: 'draft type and id must match the exact source lineage',
            keyword: 'identity',
          }],
          changedTargets: { prefabIds: [] },
        },
        422,
      );
    }

    const publishedAnimation = sealAsset({
      ...request.draft,
      metadata: {
        ...request.draft.metadata,
        assetType: request.source.assetType,
        id: request.source.assetId,
        version: bumpAssetVersion(request.source.version, 'patch'),
        contentHash: '',
      },
    } as AnimationAsset);
    const animationSchema = validateAgainst(
      animationSchemaName(publishedAnimation.metadata.assetType),
      publishedAnimation,
    );
    if (!animationSchema.valid) {
      return c.json(
        { ok: false, issues: animationSchema.issues, changedTargets: { prefabIds: [] } },
        422,
      );
    }
    const publishedReference: AssetReference = {
      assetType: publishedAnimation.metadata.assetType,
      assetId: publishedAnimation.metadata.id,
      version: publishedAnimation.metadata.version,
      contentHash: publishedAnimation.metadata.contentHash,
    };

    /*
     * Each target adopts the new animation version as a *new Prefab version*.
     * Rewriting the existing one in place is forbidden (§6.1): every Scene that
     * stands on it carries its content hash, and changing the bytes under that
     * hash breaks every one of those references at once.
     */
    const documents: GameObjectPrefabAsset[] = [];
    for (const target of plan.targets) {
      const current = registry.get(target);
      const protection = current.metadata.protection?.level;
      if (protection === 'locked' || protection === 'invariant') {
        return c.json(
          {
            ok: false,
            issues: [{
              path: '/targetPrefabIds',
              message: `${target.assetId}@${target.version} is ${protection}`,
              keyword: 'protected',
            }],
            changedTargets: { prefabIds: [] },
          },
          409,
        );
      }
      documents.push(adoptAnimationInPrefab({
        registry,
        current,
        source: request.source,
        published: publishedReference,
      }));
    }

    const outcome = await publishThroughTransaction({
      runtime,
      intent:
        `adopt ${request.source.assetId}@${request.source.version} into ` +
        `${plan.targets.map((target) => target.assetId).join(', ') || 'no Prefabs'}`,
      documents,
      animationAssets: [publishedAnimation],
      expectedPaths: [
        assetFilePath(request.source.assetType, request.source.assetId, request.source.version),
        ...plan.targets.map((target) => prefabAssetFilePath(target.assetId, target.version)),
      ],
      expectedProjectRevisionId: request.expected.projectRevisionId,
    });

    return c.json(
      {
        ...outcome.body,
        /*
         * Derived from what the transaction actually wrote, never echoed from
         * the request (§6.4). A response that repeated the request's ids would
         * confirm the client's own guess and prove nothing.
         */
        changedTargets: {
          prefabIds: outcome.ok
            ? documents.map((document) => document.metadata.id)
            : [],
        },
        published: outcome.ok
          ? {
              animation: publishedReference,
              prefabs: documents.map((document) => ({
                assetId: document.metadata.id,
                version: document.metadata.version,
                contentHash: document.metadata.contentHash,
              })),
            }
          : undefined,
      },
      outcome.status,
    );
  });

  app.post('/api/prefabs/publish-and-adopt-scenes', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, issues: [{ path: '/', message: 'body is not valid JSON', keyword: 'shape' }] }, 400);
    }

    const parsed = validateAgainst('PublishPrefabAndUpdateInstancesRequest', body);
    if (!parsed.valid) return c.json({ ok: false, issues: parsed.issues }, 400);
    const request = body as PublishPrefabAndUpdateInstancesRequest;

    const registry = loadPrefabRegistry(root);
    const project = loadProjectFrom(root);
    const usage = describePrefabUsage({ prefabRegistry: registry, scenes: scenesOf(project) });

    const plan = planPrefabAdoption({
      usage,
      request,
      currentProjectRevisionId: project.revisionId,
    });
    if (plan.conflicts.length > 0) {
      return c.json(
        {
          ok: false,
          issues: plan.conflicts.map((conflict) => ({
            path: '/expected',
            message: conflict.message,
            keyword: conflict.code,
          })),
          changedTargets: { sceneInstances: [] },
        },
        409,
      );
    }

    if (!registry.has(request.source)) {
      return c.json(
        {
          ok: false,
          issues: [
            { path: '/source', message: 'no such Prefab version', keyword: 'reference' },
          ],
          changedTargets: { sceneInstances: [] },
        },
        404,
      );
    }

    const published = nextPrefabVersion(registry.get(request.source));
    const newReference: GameObjectPrefabReference = {
      assetType: 'game-object-prefab',
      assetId: published.metadata.id,
      version: published.metadata.version,
      contentHash: published.metadata.contentHash,
    };

    /*
     * Only the named instances are re-pointed. Every other holder keeps the
     * version it had — which is what "exact target" means, and what
     * `harness:prefab-api` checks by hashing the non-target bytes.
     */
    const named = new Set(plan.targets.map((target) => `${target.sceneId}/${target.gameObjectId}`));
    const changedProject: ProjectDefinition = {
      ...project,
      scenes: project.scenes.map((scene) => ({
        ...scene,
        gameObjects: (scene.gameObjects ?? []).map((gameObject) =>
          named.has(`${scene.id}/${gameObject.id}`)
            ? { ...gameObject, prefab: newReference }
            : gameObject,
        ),
      })),
    };
    const nextProject: ProjectDefinition = {
      ...changedProject,
      revisionId: revisionOf(changedProject),
    };

    const outcome = await publishThroughTransaction({
      runtime,
      intent:
        `adopt ${published.metadata.id}@${published.metadata.version} into ` +
        `${[...named].join(', ') || 'no Scene instances'}`,
      documents: [published],
      ...(plan.targets.length > 0 ? { project: nextProject } : {}),
      expectedProjectRevisionId: request.expected.projectRevisionId,
    });

    return c.json(
      {
        ...outcome.body,
        changedTargets: {
          sceneInstances: outcome.ok
            ? plan.targets.map((target) => ({
                sceneId: target.sceneId,
                gameObjectId: target.gameObjectId,
              }))
            : [],
        },
        published: outcome.ok
          ? {
              assetId: published.metadata.id,
              version: published.metadata.version,
              contentHash: published.metadata.contentHash,
            }
          : undefined,
      },
      outcome.status,
    );
  });
}

export { computeContentHash };
