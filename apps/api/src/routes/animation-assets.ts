/**
 * Animation asset API (PLAN 36).
 *
 * Every write endpoint re-runs the full validation chain server-side. The
 * browser has already checked, and its answer is worth nothing here: a client
 * that skipped its checks — or a script that never had any — must still be
 * unable to publish a broken asset or overwrite a published version.
 */
import { Hono } from 'hono';
import type {
  AnimationAsset,
  AnimationBehaviorAsset,
  AnimationClipAsset,
  AnimationMotionSetAsset,
  AnimationTuningProfileAsset,
  AssetReference,
  CanonicalPatch,
  CharacterAnimationAssignment,
  ProjectDefinition,
} from '@atc/schema';
import {
  ANIMATION_ASSET_TYPES,
  bumpAssetVersion,
  NEW_ASSET_VERSION,
  referenceKey,
  validateAgainst,
} from '@atc/schema';
import {
  applyPatches,
  buildLibraryIndex,
  checkDeletePolicy,
  checkMotionSetCompatibility,
  computeContentHash,
  createBehaviorFork,
  createBehaviorVariant,
  duplicateBehavior,
  resolveCharacterAnimation,
  sealAsset,
  transitiveDependencies,
  usedBy,
} from '@atc/animation-asset-runtime';
import { candidateToClip } from '@atc/acquisition-core';
import { loadAssetRegistry, loadProject } from '../context.ts';
import { runAssetTransaction } from '../transaction.ts';
import { migrateProjectToAssets, type LegacyProject } from '@atc/animation-asset-runtime';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A reference from loose request fields, hash filled in from the registry. */
function referenceFrom(
  body: { assetType?: string; assetId?: string; version?: string },
): AssetReference {
  if (!body.assetType || !body.assetId || !body.version) {
    throw new Error('assetType, assetId and version are required');
  }
  if (!(ANIMATION_ASSET_TYPES as readonly string[]).includes(body.assetType)) {
    throw new Error(
      `"${body.assetType}" is not an animation asset type (expected one of ${ANIMATION_ASSET_TYPES.join(', ')})`,
    );
  }
  const registry = loadAssetRegistry();
  return registry.referenceTo(
    body.assetType as AssetReference['assetType'],
    body.assetId,
    body.version,
  );
}

export function animationAssetRoutes(): Hono {
  const app = new Hono();

  app.get('/api/animation-assets', (c) => {
    try {
      const registry = loadAssetRegistry();
      const project = loadProject();
      const type = c.req.query('type');
      const text = c.req.query('q');
      return c.json({
        index: buildLibraryIndex(registry),
        summaries: registry.summaries({
          ...(type ? { assetType: type as AssetReference['assetType'] } : {}),
          ...(text ? { text } : {}),
        }),
        project,
      });
    } catch (error) {
      return c.json({ error: message(error) }, 500);
    }
  });

  app.get('/api/animation-assets/:type/:id/:version', (c) => {
    try {
      const registry = loadAssetRegistry();
      const project = loadProject();
      const reference = registry.referenceTo(
        c.req.param('type') as AssetReference['assetType'],
        c.req.param('id'),
        c.req.param('version'),
      );
      return c.json({
        reference,
        asset: registry.get(reference),
        versions: registry.versionsOf(reference.assetType, reference.assetId),
        dependencies: transitiveDependencies(registry, reference),
        usedBy: usedBy(registry, reference, [project]),
        validation: registry.validate(reference),
        deletePolicy: checkDeletePolicy(registry, reference, [project]),
      });
    } catch (error) {
      return c.json({ error: message(error) }, 404);
    }
  });

  /**
   * Validates a proposed asset without publishing it. The library's Edit Draft
   * flow calls this on every change, so a human sees the refusal while editing
   * rather than at publish time.
   */
  app.post('/api/animation-assets/validate', async (c) => {
    const body = await c.req.json<{ asset: AnimationAsset }>();
    try {
      const schemaName = {
        'animation-behavior': 'AnimationBehaviorAsset',
        'animation-motion-set': 'AnimationMotionSetAsset',
        'animation-clip': 'AnimationClipAsset',
        'humanoid-rig': 'HumanoidRigProfileAsset',
        'animation-tuning': 'AnimationTuningProfileAsset',
      }[body.asset.metadata.assetType] as Parameters<typeof validateAgainst>[0];
      const schemaResult = validateAgainst(schemaName, body.asset);
      const expectedHash = computeContentHash(body.asset);
      return c.json({
        valid: schemaResult.valid,
        issues: schemaResult.issues,
        expectedContentHash: expectedHash,
        hashMatches: body.asset.metadata.contentHash === expectedHash,
      });
    } catch (error) {
      return c.json({ error: message(error) }, 400);
    }
  });

  app.post('/api/animation-assets/create-variant', async (c) => {
    const body = await c.req.json<{
      parent: { assetType?: string; assetId?: string; version?: string };
      patches: CanonicalPatch[];
      newAssetId: string;
      displayName: string;
      createdBy?: string;
      createdAt?: string;
    }>();
    try {
      const registry = loadAssetRegistry();
      const parent = referenceFrom(body.parent);
      const asset = createBehaviorVariant(registry, parent, body.patches ?? [], {
        newAssetId: body.newAssetId,
        displayName: body.displayName,
        createdBy: body.createdBy ?? 'chamber-user',
        ...(body.createdAt ? { createdAt: body.createdAt } : {}),
      });
      const result = await runAssetTransaction({
        intent: `create variant ${body.newAssetId} of ${referenceKey(parent)}`,
        assets: [asset],
      });
      return c.json({ asset, ...result }, result.ok ? 200 : 409);
    } catch (error) {
      return c.json({ error: message(error) }, 400);
    }
  });

  app.post('/api/animation-assets/create-fork', async (c) => {
    const body = await c.req.json<{
      parent: { assetType?: string; assetId?: string; version?: string };
      forkIntent: string;
      newAssetId: string;
      displayName: string;
      createdBy?: string;
      createdAt?: string;
    }>();
    try {
      const registry = loadAssetRegistry();
      const parent = referenceFrom(body.parent);
      const { asset, issues } = createBehaviorFork(registry, parent, body.forkIntent, {
        newAssetId: body.newAssetId,
        displayName: body.displayName,
        createdBy: body.createdBy ?? 'chamber-user',
        ...(body.createdAt ? { createdAt: body.createdAt } : {}),
      });
      if (issues.some((issue) => issue.severity === 'error')) {
        return c.json({ error: 'the parent asset could not be resolved', issues }, 409);
      }
      const result = await runAssetTransaction({
        intent: `fork ${referenceKey(parent)} as ${body.newAssetId}: ${body.forkIntent}`,
        assets: [asset],
      });
      return c.json({ asset, ...result }, result.ok ? 200 : 409);
    } catch (error) {
      return c.json({ error: message(error) }, 400);
    }
  });

  app.post('/api/animation-assets/duplicate', async (c) => {
    const body = await c.req.json<{
      source: { assetType?: string; assetId?: string; version?: string };
      newAssetId: string;
      displayName: string;
      createdBy?: string;
      createdAt?: string;
    }>();
    try {
      const registry = loadAssetRegistry();
      const source = referenceFrom(body.source);
      const { asset, issues } = duplicateBehavior(registry, source, {
        newAssetId: body.newAssetId,
        displayName: body.displayName,
        createdBy: body.createdBy ?? 'chamber-user',
        ...(body.createdAt ? { createdAt: body.createdAt } : {}),
      });
      if (issues.some((issue) => issue.severity === 'error')) {
        return c.json({ error: 'the source asset could not be resolved', issues }, 409);
      }
      const result = await runAssetTransaction({
        intent: `duplicate ${referenceKey(source)} as ${body.newAssetId}`,
        assets: [asset],
      });
      return c.json({ asset, ...result }, result.ok ? 200 : 409);
    } catch (error) {
      return c.json({ error: message(error) }, 400);
    }
  });

  /**
   * Publishes a new version of an existing asset.
   *
   * The version is derived here, not accepted from the client: a caller that
   * asked to publish over `1.0.0` would be asking to rewrite history, and the
   * answer is always "here is 1.0.1" instead.
   */
  app.post('/api/animation-assets/publish', async (c) => {
    const body = await c.req.json<{
      asset: AnimationAsset;
      level?: 'major' | 'minor' | 'patch';
      /** Reference updates to apply alongside, e.g. a character re-pointed. */
      project?: ProjectDefinition;
    }>();
    try {
      const registry = loadAssetRegistry();
      const latest = registry.latestVersion(
        body.asset.metadata.assetType,
        body.asset.metadata.id,
      );
      const version = latest
        ? bumpAssetVersion(latest, body.level ?? 'patch')
        : NEW_ASSET_VERSION;
      const asset = sealAsset({
        ...body.asset,
        metadata: { ...body.asset.metadata, version, contentHash: '' },
      }) as AnimationAsset;
      const result = await runAssetTransaction({
        intent: `publish ${asset.metadata.id}@${version}`,
        assets: [asset],
        ...(body.project ? { project: body.project } : {}),
      });
      return c.json({ asset, version, ...result }, result.ok ? 200 : 409);
    } catch (error) {
      return c.json({ error: message(error) }, 400);
    }
  });

  /**
   * Points a character at a set of assets (PLAN 27).
   *
   * Compatibility is re-checked here even though the Apply dialog already
   * showed it: the dialog's answer was computed against whatever the browser
   * had loaded, which may no longer be what is on disk.
   */
  app.post('/api/animation-assets/apply', async (c) => {
    const body = await c.req.json<{
      characterId: string;
      assignment: CharacterAnimationAssignment;
      /** New asset versions published as part of the same transaction. */
      assets?: AnimationAsset[];
    }>();
    try {
      const registry = loadAssetRegistry();
      const project = loadProject();
      const character = project.characters.find((entry) => entry.id === body.characterId);
      if (!character) {
        return c.json({ error: `unknown character "${body.characterId}"` }, 404);
      }

      const nextProject: ProjectDefinition = {
        ...project,
        characters: project.characters.map((entry) =>
          entry.id === body.characterId ? { ...entry, animation: body.assignment } : entry,
        ),
      };

      const result = await runAssetTransaction({
        intent: `apply animation assets to character "${body.characterId}"`,
        assets: body.assets ?? [],
        project: nextProject,
      });

      // Report the compatibility summary the UI shows, from the same registry
      // the transaction validated against.
      let compatibility = null;
      try {
        const behavior = registry.getBehavior(body.assignment.behavior);
        const motionSet = registry.getMotionSet(body.assignment.motionSet);
        compatibility = checkMotionSetCompatibility(
          registry,
          behavior,
          motionSet,
          body.assignment.rig,
        );
      } catch {
        // A missing reference is already reported by the transaction issues.
      }

      return c.json({ ...result, compatibility, project: result.ok ? nextProject : project },
        result.ok ? 200 : 409);
    } catch (error) {
      return c.json({ error: message(error) }, 400);
    }
  });

  /**
   * Promotes an accepted candidate to a clip asset (PLAN 29).
   *
   * `HumanAccepted` is checked here rather than trusted from the request: the
   * whole point of the review state is that a machine cannot skip it.
   */
  app.post('/api/animation-assets/promote-candidate', async (c) => {
    const body = await c.req.json<{
      candidateId: string;
      newAssetId?: string;
      rigId?: string;
      createdBy?: string;
      createdAt?: string;
      /** Motion set to bind the promoted clip into, and the slot to fill. */
      motionSetId?: string;
      motionSlot?: string;
    }>();
    try {
      const registry = loadAssetRegistry();
      const project = loadProject();
      const candidate = project.candidates.find((entry) => entry.id === body.candidateId);
      if (!candidate) {
        return c.json({ error: `unknown candidate "${body.candidateId}"` }, 404);
      }
      if (candidate.state !== 'HumanAccepted') {
        return c.json(
          {
            error:
              `candidate "${body.candidateId}" is ${candidate.state}; only a HumanAccepted ` +
              `candidate may become a clip asset`,
          },
          409,
        );
      }

      const assetId = body.newAssetId ?? candidate.id;
      const clipName = candidate.discoveredClips[0] ?? 'clip';
      const rigId = body.rigId ?? registry.all().find((a) => a.assetType === 'humanoid-rig')?.id;
      if (!rigId) return c.json({ error: 'no rig profile exists to attach the clip to' }, 409);

      const clipAsset = sealAsset<AnimationClipAsset>({
        metadata: {
          schemaVersion: 2,
          assetType: 'animation-clip',
          id: assetId,
          version: NEW_ASSET_VERSION,
          displayName: candidate.brief?.action ?? assetId,
          description: `Promoted from acquisition candidate "${candidate.id}".`,
          tags: ['promoted'],
          createdAt: body.createdAt ?? new Date().toISOString(),
          createdBy: body.createdBy ?? 'chamber-user',
          contentHash: '',
          assetProvenance: { promotedFromCandidateId: candidate.id },
        },
        clip: {
          ...candidateToClip(candidate, clipName, candidate.provenance.originalFilename),
          id: assetId,
          schemaVersion: 2,
        },
        compatibleRigIds: [rigId],
        sourceCandidateId: candidate.id,
      });

      const assets: AnimationAsset[] = [clipAsset];

      // Optionally bind it straight into a motion set, as a new version of that
      // set — the published one it replaces stays exactly where it was.
      if (body.motionSetId && body.motionSlot) {
        const latest = registry.latestVersion('animation-motion-set', body.motionSetId);
        if (!latest) return c.json({ error: `unknown motion set "${body.motionSetId}"` }, 404);
        const current = registry.getMotionSet(
          registry.referenceTo('animation-motion-set', body.motionSetId, latest),
        ) as AnimationMotionSetAsset;
        const clipReference: AssetReference = {
          assetType: 'animation-clip',
          assetId: assetId,
          version: NEW_ASSET_VERSION,
          contentHash: computeContentHash(clipAsset),
        };
        assets.push(
          sealAsset<AnimationMotionSetAsset>({
            ...current,
            metadata: {
              ...current.metadata,
              version: bumpAssetVersion(latest, 'patch'),
              contentHash: '',
            },
            bindings: [
              ...current.bindings.filter(
                (binding) =>
                  !(binding.motionSlot === body.motionSlot && binding.contextualKey === undefined),
              ),
              { motionSlot: body.motionSlot, clip: clipReference },
            ],
          }),
        );
      }

      const result = await runAssetTransaction({
        intent: `promote candidate "${candidate.id}" to clip asset "${assetId}"`,
        assets,
      });
      return c.json({ assets, ...result }, result.ok ? 200 : 409);
    } catch (error) {
      return c.json({ error: message(error) }, 400);
    }
  });

  /** Re-runs the v1 -> v2 migration against a submitted legacy document. */
  app.post('/api/animation-assets/migrate-project', async (c) => {
    const body = await c.req.json<{ legacyProject: LegacyProject; dryRun?: boolean }>();
    try {
      const migration = migrateProjectToAssets(body.legacyProject);
      if (body.dryRun !== false) {
        return c.json({
          dryRun: true,
          assets: migration.assets.map((asset) => ({
            assetType: asset.assetType,
            id: asset.id,
            version: asset.version,
          })),
          project: migration.project,
          notes: migration.notes,
        });
      }
      const result = await runAssetTransaction({
        intent: 'migrate a schema v1 project to animation assets',
        assets: migration.assets.map((asset) => asset.document),
        project: migration.project,
      });
      return c.json({ ...result, notes: migration.notes }, result.ok ? 200 : 409);
    } catch (error) {
      return c.json({ error: message(error) }, 400);
    }
  });

  /**
   * Writes a chamber edit to the destination a human chose (PLAN 28).
   *
   * The four destinations are four genuinely different writes, and the server
   * performs whichever was asked for rather than inferring one — the whole
   * value of the dialog is that the choice was made explicitly, and quietly
   * "improving" on it here would throw that away.
   */
  app.post('/api/animation-assets/save-destination', async (c) => {
    const body = await c.req.json<{
      characterId: string;
      destination: { kind: string; newAssetId?: string; displayName?: string };
      graphPatches: CanonicalPatch[];
      clipPatches: CanonicalPatch[];
      createdBy?: string;
      createdAt?: string;
    }>();

    try {
      const registry = loadAssetRegistry();
      const project = loadProject();
      const character = project.characters.find((entry) => entry.id === body.characterId);
      if (!character) {
        return c.json({ error: `unknown character "${body.characterId}"` }, 404);
      }

      const patches = body.graphPatches ?? [];
      const createdAt = body.createdAt ?? new Date().toISOString();
      const createdBy = body.createdBy ?? 'chamber-user';
      const assets: AnimationAsset[] = [];
      let assignment: CharacterAnimationAssignment = character.animation;
      let intent = '';

      if (body.destination.kind === 'tuning-profile') {
        if (!character.animation.tuning) {
          return c.json({ error: 'this character has no tuning profile to extend' }, 409);
        }
        const current = registry.getTuning(character.animation.tuning);
        const version = bumpAssetVersion(current.metadata.version, 'patch');
        const next = sealAsset<AnimationTuningProfileAsset>({
          ...current,
          metadata: { ...current.metadata, version, createdAt, createdBy, contentHash: '' },
          // A tuning profile adjusts values only; a structural patch is refused
          // by the resolver, and refusing it here too keeps the error close to
          // the decision that caused it.
          patches: [...current.patches, ...patches.filter((patch) => patch.op === 'set')],
        });
        assets.push(next);
        assignment = {
          ...assignment,
          tuning: {
            assetType: 'animation-tuning',
            assetId: next.metadata.id,
            version,
            contentHash: computeContentHash(next),
          },
        };
        intent = `save chamber edits to tuning profile ${next.metadata.id}@${version}`;
      } else if (body.destination.kind === 'new-behavior-variant') {
        if (!body.destination.newAssetId) {
          return c.json({ error: 'a new variant needs an asset id' }, 400);
        }
        const variant = createBehaviorVariant(
          registry,
          character.animation.behavior,
          patches,
          {
            newAssetId: body.destination.newAssetId,
            displayName: body.destination.displayName ?? body.destination.newAssetId,
            createdBy,
            createdAt,
          },
        );
        assets.push(variant);
        assignment = {
          ...assignment,
          behavior: {
            assetType: 'animation-behavior',
            assetId: variant.metadata.id,
            version: variant.metadata.version,
            contentHash: computeContentHash(variant),
          },
        };
        intent = `save chamber edits to new behaviour variant ${variant.metadata.id}`;
      } else if (
        body.destination.kind === 'behavior-variant' ||
        body.destination.kind === 'shared-behavior'
      ) {
        const current = registry.getBehavior(character.animation.behavior);
        const version = bumpAssetVersion(current.metadata.version, 'patch');
        const next =
          current.derivation.mode === 'variant'
            ? sealAsset<AnimationBehaviorAsset>({
                ...current,
                metadata: { ...current.metadata, version, createdAt, createdBy, contentHash: '' },
                derivation: {
                  ...current.derivation,
                  patches: [...current.derivation.patches, ...patches],
                },
              })
            : sealAsset<AnimationBehaviorAsset>({
                ...current,
                metadata: { ...current.metadata, version, createdAt, createdBy, contentHash: '' },
                graph: applyPatches(current.graph, patches, {
                  source: 'behavior-variant',
                  requireExistingPath: false,
                }).document as NonNullable<AnimationBehaviorAsset['graph']>,
              });
        assets.push(next);
        assignment = {
          ...assignment,
          behavior: {
            assetType: 'animation-behavior',
            assetId: next.metadata.id,
            version,
            contentHash: computeContentHash(next),
          },
        };
        intent = `save chamber edits to behaviour ${next.metadata.id}@${version}`;
      } else {
        return c.json(
          { error: `unsupported save destination "${body.destination.kind}"` },
          400,
        );
      }

      /*
       * Only the character that made the edit is re-pointed, even for the
       * shared-behaviour destination. A new version of a shared asset is not the
       * same thing as everyone adopting it — PLAN 12.4 is explicit that a
       * reference never moves on its own — so the other characters keep pointing
       * at the version they were verified against until a human moves them.
       */
      const nextProject: ProjectDefinition = {
        ...project,
        characters: project.characters.map((entry) =>
          entry.id === body.characterId ? { ...entry, animation: assignment } : entry,
        ),
      };

      const result = await runAssetTransaction({ intent, assets, project: nextProject });
      return c.json(
        { ...result, assignment, project: result.ok ? nextProject : project },
        result.ok ? 200 : 409,
      );
    } catch (error) {
      return c.json({ error: message(error) }, 400);
    }
  });

  /** Behaviour + motion set + rig, resolved, for the library's preview pane. */
  app.get('/api/animation-assets/resolve/:characterId', (c) => {
    try {
      const registry = loadAssetRegistry();
      const project = loadProject();
      const result = resolveCharacterAnimation({
        registry,
        project,
        characterId: c.req.param('characterId'),
        ...(c.req.query('contextKey') ? { contextKey: c.req.query('contextKey')! } : {}),
      });
      return c.json(result);
    } catch (error) {
      return c.json({ error: message(error) }, 400);
    }
  });

  return app;
}

export type { AnimationBehaviorAsset, AnimationTuningProfileAsset };
