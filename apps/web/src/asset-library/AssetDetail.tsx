/**
 * Asset detail views (PLAN 25).
 *
 * One component per asset type, dispatched by type, because the five types
 * genuinely have nothing to show in common beyond their metadata — a shared
 * "property grid" would have been a lie held together by conditionals.
 */
import type {
  AnimationBehaviorAsset,
  AnimationClipAsset,
  AnimationMotionSetAsset,
  AnimationTuningProfileAsset,
  AssetReference,
  HumanoidRigProfileAsset,
  GameObjectPrefabReference,
} from '@atc/schema';
import {
  checkMotionSetCompatibility,
  describeIncompatibility,
  resolveBehaviorAsset,
  retargetStatusBetween,
} from '@atc/animation-asset-runtime';
import { getAtPath } from '@atc/runtime-core';
import { useChamber } from '../store.ts';
import {
  checkPrefabDeletePolicy,
  describePrefabUsage,
  directDependencies,
  resolveGameObjectPrefab,
  walkResolvedNodes,
} from '@atc/prefab-runtime';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { DependencyView } from './DependencyView.tsx';
import { MotionSetEditor } from './MotionSetEditor.tsx';
import { VersionDiff } from './VersionDiff.tsx';
import { AssetActions } from './AssetActions.tsx';

function Metadata({ reference }: { reference: AssetReference }) {
  const registry = useChamber((state) => state.registry);
  const asset = registry.find(reference);
  const validation = registry.validate(reference);
  if (!asset) return null;

  return (
    <header className="asset-detail__header" data-testid="asset-detail-metadata">
      <h2>{asset.metadata.displayName}</h2>
      <p className="muted">{asset.metadata.description}</p>
      <dl className="asset-facts">
        <div>
          <dt>Id</dt>
          <dd>
            <code>{asset.metadata.id}</code>
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd data-testid="asset-detail-version">{asset.metadata.version}</dd>
        </div>
        <div>
          <dt>Content hash</dt>
          <dd>
            <code>{asset.metadata.contentHash.slice(0, 12)}</code>
          </dd>
        </div>
        <div>
          <dt>Protection</dt>
          <dd>{asset.metadata.protection?.level ?? 'editable'}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            {asset.metadata.createdAt} by {asset.metadata.createdBy}
          </dd>
        </div>
      </dl>
      {asset.metadata.tags.length > 0 && (
        <p className="asset-detail__tags">{asset.metadata.tags.join(' · ')}</p>
      )}
      {!validation.valid && (
        <ul className="asset-issues" data-testid="asset-detail-issues">
          {validation.issues.map((issue, index) => (
            <li key={index}>
              <strong>{issue.code}</strong> {issue.message}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

function BehaviorDetail({ reference }: { reference: AssetReference }) {
  const registry = useChamber((state) => state.registry);
  // `asset` is the stored shape — a variant has no payload of its own, so the
  // derivation section reads it directly. Everything else shows the
  // *resolved* contract (inherited slots and patches applied), which is what
  // a human means by "what does this behaviour actually do".
  const asset = registry.get(reference) as AnimationBehaviorAsset;
  const resolved = resolveBehaviorAsset(registry, reference).asset;
  const project = useChamber((state) => state.project);

  return (
    <>
      <section data-testid="behavior-derivation">
        <h4>Derivation</h4>
        {asset.derivation.mode === 'base' && <p className="muted">Authored outright.</p>}
        {asset.derivation.mode === 'variant' && (
          <p>
            Variant of <code>{asset.derivation.parent.assetId}</code> v
            {asset.derivation.parent.version}, storing {asset.derivation.patches.length} patch
            {asset.derivation.patches.length === 1 ? '' : 'es'} and nothing else.
          </p>
        )}
        {asset.derivation.mode === 'fork' && (
          <p>
            Forked from <code>{asset.derivation.forkedFrom.assetId}</code> v
            {asset.derivation.forkedFrom.version}. Detached — it resolves without its origin.
            <br />
            <em>{asset.derivation.forkIntent}</em>
          </p>
        )}
      </section>

      <section data-testid="behavior-motion-slots">
        <h4>Motion slot contract</h4>
        <table className="asset-table">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Required</th>
              <th>Loop</th>
              <th>Fallback</th>
            </tr>
          </thead>
          <tbody>
            {resolved.motionSlots.map((slot) => (
              <tr key={slot.id}>
                <td>
                  <code>{slot.id}</code>
                </td>
                <td>{slot.required ? 'yes' : 'no'}</td>
                <td>{slot.expectedLoop ? 'yes' : '—'}</td>
                <td>{slot.fallbackSlot ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section data-testid="behavior-parameters">
        <h4>Parameters</h4>
        <p className="muted">
          {resolved.parameters.map((parameter) => `${parameter.name}:${parameter.kind}`).join(', ') ||
            'none declared'}
        </p>
      </section>

      <section data-testid="behavior-states">
        <h4>States</h4>
        <p className="muted">
          {(resolved.graph.states.length ?? project.graph.states.length)} states,{' '}
          {(resolved.graph.transitions.length ?? project.graph.transitions.length)} transitions across{' '}
          {(resolved.graph.layers.length ?? project.graph.layers.length)} layers. The full graph is
          editable in the Chamber’s Graph panel.
        </p>
      </section>

      <section data-testid="behavior-replays">
        <h4>Replay fixtures</h4>
        <p className="muted">{resolved.replayFixtureIds.join(', ') || 'none'}</p>
      </section>
    </>
  );
}

function MotionSetDetail({ reference }: { reference: AssetReference }) {
  const registry = useChamber((state) => state.registry);
  const project = useChamber((state) => state.project);
  const asset = registry.get(reference) as AnimationMotionSetAsset;

  // Compatibility is reported against the *active character's* behaviour and
  // rig, because "is this set usable" has no answer in the abstract.
  const behaviorReference = project.character.animation.behavior;
  const compatibility = registry.has(behaviorReference)
    ? checkMotionSetCompatibility(
        registry,
        resolveBehaviorAsset(registry, behaviorReference).asset,
        asset,
        project.character.animation.rig,
      )
    : null;

  return (
    <>
      <section data-testid="motion-set-compatibility">
        <h4>Compatibility with {project.character.displayName}</h4>
        {compatibility === null ? (
          <p className="muted">The active character’s behaviour could not be resolved.</p>
        ) : (
          <>
            <p data-testid="motion-set-retarget">
              Rig: <strong>{compatibility.retargetStatus}</strong>
            </p>
            {compatibility.missingSlots.length > 0 && (
              <p className="asset-warning" data-testid="motion-set-missing">
                Missing required slots: {compatibility.missingSlots.join(', ')}
              </p>
            )}
            {compatibility.issues.map((issue, index) => (
              <p key={index} className={issue.severity === 'error' ? 'asset-warning' : 'muted'}>
                {issue.message}
              </p>
            ))}
          </>
        )}
      </section>
      <MotionSetEditor reference={reference} />
    </>
  );
}

function ClipDetail({ reference }: { reference: AssetReference }) {
  const registry = useChamber((state) => state.registry);
  const asset = registry.get(reference) as AnimationClipAsset;
  const clip = asset.clip;

  return (
    <>
      <section data-testid="clip-facts">
        <h4>Motion</h4>
        <dl className="asset-facts">
          <div>
            <dt>Duration</dt>
            <dd>{clip.durationSec.toFixed(3)}s</dd>
          </div>
          <div>
            <dt>Loop</dt>
            <dd>{clip.loop ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Root motion</dt>
            <dd>
              {clip.rootMotionMode} · z {clip.rootDisplacement.z.toFixed(3)}m
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{clip.assetPath ?? `procedural: ${clip.proceduralGenerator ?? 'none'}`}</dd>
          </div>
          <div>
            <dt>From candidate</dt>
            <dd>{asset.sourceCandidateId ?? '—'}</dd>
          </div>
        </dl>
      </section>

      {/* A clip preview without a renderer would be a lie, so this is the
          authored timing laid out to scale — which is what the timeline panel
          shows anyway, and is honest on a static host. */}
      <section data-testid="clip-preview">
        <h4>Preview</h4>
        <div className="clip-track" aria-hidden="true">
          {clip.events.map((event) => (
            <span
              key={event.id}
              className="clip-track__event"
              style={{ left: `${event.at * 100}%` }}
              title={`${event.kind} @ ${event.at.toFixed(2)}`}
            />
          ))}
          {clip.footContacts.left.map((window, index) => (
            <span
              key={`l${index}`}
              className="clip-track__contact clip-track__contact--left"
              style={{
                left: `${window.start * 100}%`,
                width: `${(window.end - window.start) * 100}%`,
              }}
            />
          ))}
          {clip.footContacts.right.map((window, index) => (
            <span
              key={`r${index}`}
              className="clip-track__contact clip-track__contact--right"
              style={{
                left: `${window.start * 100}%`,
                width: `${(window.end - window.start) * 100}%`,
              }}
            />
          ))}
        </div>
        <p className="muted">
          {clip.events.length} semantic event{clip.events.length === 1 ? '' : 's'} ·{' '}
          {clip.footContacts.left.length + clip.footContacts.right.length} foot contact window(s)
        </p>
      </section>

      <section data-testid="clip-events">
        <h4>Semantic events</h4>
        {clip.events.length === 0 ? (
          <p className="muted">None authored.</p>
        ) : (
          <ul>
            {clip.events.map((event) => (
              <li key={event.id}>
                <code>{event.kind}</code> at {event.at.toFixed(3)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4>Compatible rigs</h4>
        <p className="muted">{asset.compatibleRigIds.join(', ') || 'any'}</p>
      </section>
    </>
  );
}

function RigDetail({ reference }: { reference: AssetReference }) {
  const registry = useChamber((state) => state.registry);
  const project = useChamber((state) => state.project);
  const asset = registry.get(reference) as HumanoidRigProfileAsset;
  const characterRigReference = project.character.animation.rig;
  const characterRig = registry.has(characterRigReference)
    ? registry.getRig(characterRigReference)
    : null;
  const status = characterRig ? retargetStatusBetween(asset, characterRig) : null;

  return (
    <>
      <section data-testid="rig-facts">
        <h4>Skeleton</h4>
        <dl className="asset-facts">
          <div>
            <dt>Compatibility key</dt>
            <dd>
              <code>{asset.compatibilityKey}</code>
            </dd>
          </div>
          <div>
            <dt>Height</dt>
            <dd>{asset.skeleton.height}m</dd>
          </div>
          <div>
            <dt>Bones</dt>
            <dd>{asset.skeleton.bones.length}</dd>
          </div>
          <div>
            <dt>Forward axis</dt>
            <dd>{asset.coordinateSystem.forwardAxis}</dd>
          </div>
          <div>
            <dt>Retarget status</dt>
            <dd data-testid="rig-retarget-status">{asset.retargetStatus}</dd>
          </div>
        </dl>
      </section>

      <section data-testid="rig-bones">
        <h4>Humanoid bone mapping</h4>
        <table className="asset-table">
          <tbody>
            {Object.entries(asset.humanoidBones).map(([slot, bone]) => (
              <tr key={slot}>
                <td>{slot}</td>
                <td>
                  <code>{bone}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {status === 'conversion-required' && characterRig && (
        <p className="asset-warning" data-testid="rig-conversion-reason">
          Clips on this rig cannot play on {project.character.displayName}:{' '}
          {describeIncompatibility(asset, characterRig)}
        </p>
      )}
    </>
  );
}

function TuningDetail({ reference }: { reference: AssetReference }) {
  const registry = useChamber((state) => state.registry);
  const project = useChamber((state) => state.project);
  const asset = registry.get(reference) as AnimationTuningProfileAsset;

  return (
    <section data-testid="tuning-overrides">
      <h4>Overrides</h4>
      <p className="muted">
        Target behaviour: <code>{asset.compatibleBehavior.assetId}</code> v
        {asset.compatibleBehavior.version}
      </p>
      {asset.patches.length === 0 ? (
        <p className="muted" data-testid="tuning-empty">
          No overrides. This character runs the shared behaviour unmodified.
        </p>
      ) : (
        <table className="asset-table">
          <thead>
            <tr>
              <th>Path</th>
              <th>Override</th>
              <th>Effective</th>
            </tr>
          </thead>
          <tbody>
            {asset.patches.map((patch) => (
              <tr key={patch.path}>
                <td>
                  <code>{patch.path}</code>
                </td>
                <td>{JSON.stringify(patch.value)}</td>
                <td>{JSON.stringify(getAtPath(project.graph, patch.path))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PrefabDetail({ selection }: { selection: { assetId: string; version: string } }) {
  const registry = browserPrefabRegistry();
  const scenes = useChamber((state) => state.canonicalProject.scenes);
  if (!registry.versionsOf(selection.assetId).includes(selection.version)) {
    return <p className="asset-warning">This exact Prefab version is no longer available.</p>;
  }
  const reference: GameObjectPrefabReference = registry.referenceTo(
    selection.assetId,
    selection.version,
  );
  const document = registry.get(reference);
  const validation = registry.validate(reference);
  const resolution = resolveGameObjectPrefab(registry, reference);
  const usage = describePrefabUsage({ prefabRegistry: registry, scenes }).find(
    (entry) => entry.prefab.assetId === reference.assetId && entry.prefab.version === reference.version,
  );
  const policy = checkPrefabDeletePolicy({ registry, reference, scenes });

  return (
    <div className="asset-detail" data-testid="prefab-detail">
      <header className="asset-detail__header">
        <h2>{document.metadata.displayName}</h2>
        <p className="muted">{document.metadata.description}</p>
        <dl className="asset-facts">
          <div><dt>Exact reference</dt><dd><code>{reference.assetId}@{reference.version}</code></dd></div>
          <div><dt>Content hash</dt><dd><code>{reference.contentHash}</code></dd></div>
          <div><dt>Derivation</dt><dd>{document.derivation.mode}</dd></div>
          <div><dt>Placeable</dt><dd>{document.abstract ? 'no — abstract' : 'yes'}</dd></div>
        </dl>
      </header>
      {'parent' in document.derivation && (
        <section data-testid="prefab-parent">
          <h4>Parent</h4>
          <code>{document.derivation.parent.assetId}@{document.derivation.parent.version}</code>
          <p>{document.derivation.patches.length} stored patch(es)</p>
        </section>
      )}
      <section data-testid="prefab-components">
        <h4>Components</h4>
        <ul>
          {walkResolvedNodes(resolution.prefab.root).flatMap((node) =>
            node.components.map((component) => (
              <li key={`${node.nodePath}/${component.componentId}`}>
                <code>{node.nodePath}</code> — {component.componentType} ({component.componentId})
              </li>
            )),
          )}
        </ul>
      </section>
      <section data-testid="prefab-dependencies">
        <h4>Dependencies</h4>
        <ul>
          {directDependencies(document).map((dependency) => (
            <li key={`${dependency.assetType}:${dependency.assetId}@${dependency.version}`}>
              <code>{dependency.assetType}:{dependency.assetId}@{dependency.version}</code>
            </li>
          ))}
          {(usage?.animationReferences ?? []).map((dependency) => (
            <li key={`resolved:${dependency.assetType}:${dependency.assetId}@${dependency.version}`}>
              <code>{dependency.assetType}:{dependency.assetId}@{dependency.version}</code>
              {' (resolved)'}
            </li>
          ))}
          {(usage?.modelAssetPaths ?? []).map((path) => (
            <li key={path}><code>{path}</code></li>
          ))}
        </ul>
      </section>
      <section data-testid="prefab-usage">
        <h4>Usage</h4>
        <p>{usage?.sceneInstances.length ?? 0} Scene instance(s); {usage?.nestedBy.length ?? 0} nesting Prefab(s); {usage?.variantChildren.length ?? 0} variant child(ren).</p>
      </section>
      <section data-testid="prefab-validation">
        <h4>Validation</h4>
        <p>{validation.valid && resolution.issues.length === 0 ? 'valid' : 'invalid'}</p>
        {[...validation.issues, ...resolution.issues].map((issue, index) => (
          <p className="asset-warning" key={`${issue.code}-${index}`}>{issue.code}: {issue.message}</p>
        ))}
      </section>
      <section data-testid="prefab-delete-policy">
        <h4>Delete policy</h4>
        <p>{policy.allowed ? 'May be deleted.' : 'Deletion blocked.'}</p>
        {policy.blockers.map((blocker, index) => <p key={index}>{blocker.message}</p>)}
      </section>
    </div>
  );
}

export function AssetDetail() {
  const selection = useChamber((state) => state.librarySelection);
  const registry = useChamber((state) => state.registry);
  useChamber((state) => state.revision);

  if (!selection) {
    return (
      <div className="asset-detail" data-testid="asset-detail-empty">
        <p className="muted">Select an asset to see what it is, what it needs, and who uses it.</p>
      </div>
    );
  }

  if (selection.assetType === 'game-object-prefab') {
    return <PrefabDetail selection={selection} />;
  }

  const selectionKey: AssetReference = {
    assetType: selection.assetType as AssetReference['assetType'],
    assetId: selection.assetId,
    version: selection.version,
    contentHash: '',
  };

  if (!registry.has(selectionKey)) {
    return (
      <div className="asset-detail" data-testid="asset-detail-missing">
        <p className="asset-warning">
          {selection.assetId} v{selection.version} is no longer in the registry.
        </p>
      </div>
    );
  }

  // The selection only ever carries assetType/id/version (there is no reason
  // for the library card to know a hash), so the real reference — the one
  // every downstream `checkReference` call actually verifies against — is
  // filled in here, once, from the registry.
  const reference = registry.referenceTo(selectionKey.assetType, selectionKey.assetId, selectionKey.version);

  return (
    <div className="asset-detail" data-testid="asset-detail">
      <Metadata reference={reference} />
      <AssetActions reference={reference} />
      {reference.assetType === 'animation-behavior' && <BehaviorDetail reference={reference} />}
      {reference.assetType === 'animation-motion-set' && <MotionSetDetail reference={reference} />}
      {reference.assetType === 'animation-clip' && <ClipDetail reference={reference} />}
      {reference.assetType === 'humanoid-rig' && <RigDetail reference={reference} />}
      {reference.assetType === 'animation-tuning' && <TuningDetail reference={reference} />}
      <VersionDiff reference={reference} />
      <DependencyView reference={reference} />
    </div>
  );
}
