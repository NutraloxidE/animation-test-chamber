/**
 * The Prefab Overview (§4).
 *
 * What the Character Overview was, asking the question a Prefab makes askable:
 * *what am I editing, what is it made of, and who stands on it?*
 *
 * The Character Overview could only describe animation bindings, because a
 * Character was only ever an animation subject. A Prefab is a composition, so
 * this states derivation, patches, nodes, Components, models, Animator
 * references, nested Prefabs and — the part that decides whether an edit is
 * local or a blast radius — the exact Scene GameObjects and Prefabs holding
 * this exact version.
 *
 * Every count comes from `describePrefabUsage`, the same graph the delete
 * policy and the adoption planner read. A second scan here could say "only this
 * Scene" while a publish reached four others, and both would look right.
 */
import type { GameObjectPrefabAsset } from '@atc/schema';
import type { PrefabUsageDescription } from '@atc/prefab-runtime';
import type { ResolvedGameObjectPrefab } from '@atc/prefab-runtime';
import { walkResolvedNodes } from '@atc/prefab-runtime';
import { Link } from 'react-router-dom';
import { prefabEditorPath } from '../app/routes.ts';
import { prefabParentReference } from './resolve-prefab-editor-target.ts';
import { sceneEditorPath } from '../app/routes.ts';

export function PrefabOverview({
  resolved,
  document,
  usage,
}: {
  resolved: ResolvedGameObjectPrefab;
  /** The stored payload. Derivation and patches are authored, not resolved. */
  document: GameObjectPrefabAsset;
  usage: PrefabUsageDescription | undefined;
}): JSX.Element {
  const nodes = walkResolvedNodes(resolved.root);
  const components = nodes.flatMap((node) => node.components);
  const animatorReferences = components.flatMap((component) =>
    component.componentType === 'animator'
      ? [component.assignment.behavior, component.assignment.motionSet, component.assignment.rig]
      : [],
  );
  const capsule = components.find((component) => component.componentType === 'capsule-collider');
  const sockets = components.flatMap((component) =>
    component.componentType === 'equipment-sockets' ? component.sockets : [],
  );
  const sceneInstances = usage?.sceneInstances ?? [];
  const parent = prefabParentReference(document);

  return (
    <section className="prefab-overview" data-testid="prefab-overview">
      <header>
        <h2>{resolved.displayName}</h2>
        <span className="badge" data-testid="prefab-overview-derivation">
          {document.derivation.mode}
        </span>
        <span className="badge" data-testid="prefab-overview-version">
          {resolved.reference.assetId}@{resolved.reference.version}
        </span>
        <span className="badge" data-testid="prefab-overview-placement">
          {resolved.abstract ? 'abstract' : 'placeable'}
        </span>
        {/* Sharing is legitimate; discovering it after a publish is not. */}
        <span
          className={`badge badge--${sceneInstances.length > 1 ? 'shared' : 'exclusive'}`}
          data-testid="prefab-overview-holders"
        >
          {sceneInstances.length === 0
            ? 'PLACED IN NO SCENE'
            : sceneInstances.length === 1
              ? 'ONE SCENE INSTANCE'
              : `SHARED BY ${sceneInstances.length} SCENE INSTANCES`}
        </span>
      </header>

      <dl>
        <dt>Derivation</dt>
        <dd data-testid="prefab-overview-parent">
          {parent === undefined
            ? 'base — no parent'
            : `${document.derivation.mode} of ${parent.assetId}@${parent.version}`}
        </dd>

        <dt>Patches</dt>
        <dd data-testid="prefab-overview-patches">
          {document.derivation.mode === 'variant'
            ? document.derivation.patches.map((patch) => patch.kind).join(', ') || 'none'
            : 'none'}
        </dd>

        <dt>Nodes</dt>
        <dd data-testid="prefab-overview-nodes">
          {nodes.map((node) => node.nodePath).join(', ')}
        </dd>

        <dt>Components</dt>
        <dd data-testid="prefab-overview-components">
          {[...new Set(components.map((component) => component.componentType))].sort().join(', ') ||
            'none'}
        </dd>

        <dt>Model</dt>
        <dd data-testid="prefab-overview-models">
          {components
            .flatMap((component) =>
              component.componentType === 'model-renderer'
                ? [
                    component.model.kind === 'repository-model'
                      ? component.model.assetPath
                      : `procedural: ${component.model.presetId}`,
                  ]
                : [],
            )
            .join(', ') || 'none'}
        </dd>

        <dt>Animator references</dt>
        <dd data-testid="prefab-overview-animation">
          {animatorReferences.map((reference) => `${reference.assetId}@${reference.version}`).join(', ') ||
            'none'}
        </dd>

        <dt>Capsule</dt>
        <dd data-testid="prefab-overview-capsule">
          {capsule && capsule.componentType === 'capsule-collider'
            ? `r ${capsule.radius} · h ${capsule.height}`
            : 'none'}
        </dd>

        <dt>Sockets</dt>
        <dd data-testid="prefab-overview-sockets">
          {sockets.map((socket) => socket.socketId).join(', ') || 'none'}
        </dd>

        <dt>Nested Prefabs</dt>
        <dd data-testid="prefab-overview-nested">
          {(usage?.nestedPrefabs ?? []).length === 0
            ? 'none'
            : (usage?.nestedPrefabs ?? []).map((nested) => (
                <Link key={`${nested.assetId}@${nested.version}`} to={prefabEditorPath(nested.assetId)}>
                  {nested.assetId}@{nested.version}{' '}
                </Link>
              ))}
        </dd>

        <dt>Scene holders</dt>
        <dd data-testid="prefab-overview-scene-holders">
          {sceneInstances.length === 0
            ? 'none'
            : sceneInstances.map((instance) => (
                <Link
                  key={`${instance.sceneId}/${instance.gameObjectId}`}
                  to={sceneEditorPath(instance.sceneId)}
                >
                  {instance.sceneId}/{instance.gameObjectId}{' '}
                </Link>
              ))}
        </dd>

        <dt>Prefab holders</dt>
        <dd data-testid="prefab-overview-prefab-holders">
          {[...(usage?.nestedBy ?? []), ...(usage?.variantChildren ?? [])]
            .map((holder) => `${holder.assetId}@${holder.version}`)
            .join(', ') || 'none'}
        </dd>
      </dl>
    </section>
  );
}
