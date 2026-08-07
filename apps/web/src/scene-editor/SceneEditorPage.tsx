/**
 * `/edit/scene/:sceneId` — the Scene Editor shell.
 *
 * Unity-like composition layout: Hierarchy on the left, viewport in the centre,
 * Inspector and Asset Panel sharing the right dock (work package §11.2).
 *
 * Since the Scene cutover (DECISION 0025) every surface on this page reads
 * `scene.gameObjects` and every action writes a GameObject operation. Both
 * halves moved together on purpose: a page whose viewport read `gameObjects`
 * while its Inspector wrote `entities` would need a migration between every edit
 * and the next frame, and the migration would then be the thing that decides
 * what the Scene means.
 *
 * There is no `entity.kind` here, no character/prop/light/camera branch, and no
 * lookup that turns an id into geometry. What an object *is* comes from the
 * Components its resolved Prefab carries, which is what the hierarchy badges,
 * the Inspector's available actions and the renderer all read.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  GameObjectInstanceDefinition,
  GameObjectPrefabReference,
  SceneDefinition,
} from '@atc/schema';
import { IDENTITY_ROTATION, UNIT_SCALE } from '@atc/schema';
import { overridesClearedByPrefabSourceChange } from '@atc/editor-core';
import type { PrefabCapabilities } from '@atc/prefab-runtime';
import { useChamber } from '../store.ts';
import { routeId, prefabEditorPath, sceneEditorPath } from '../app/routes.ts';
import { NotFoundPage } from '../app/NotFoundPage.tsx';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import type { RenderProjectionIssue } from '../game-objects/render-projection.ts';
import {
  PREFAB_FILTERS,
  PREFAB_FILTER_LABELS,
  filterPrefabRows,
  prefabListRows,
  type PrefabFilterId,
} from '../prefab-editor/prefab-list.ts';
import { resolveSceneEditorTarget } from './resolve-scene-editor-target.ts';
import { useSceneSession, type SceneSessionHandle } from './use-scene-session.ts';
import { useSceneRuntime } from './use-scene-runtime.ts';
import {
  hierarchyRowFor,
  sceneHierarchyRows,
  type SceneHierarchyComponentRow,
  type SceneHierarchyRow,
} from './scene-hierarchy.ts';
import {
  fieldScope,
  fieldValue,
  mergePatch,
  overridableFields,
  patchForField,
  type OverrideField,
} from './component-override-fields.ts';
import { operationTarget, selectedNodeId, type SceneSelection } from './scene-selection.ts';
import { SceneViewport, type GizmoMode, type TransformSpace } from './viewport/SceneViewport.tsx';
import { placementGameObjectId, writeDragPayload } from './drag-payload.ts';

export function SceneEditorPage(): JSX.Element {
  const sceneId = routeId(useParams().sceneId);
  const project = useChamber((state) => state.canonicalProject);
  const target = resolveSceneEditorTarget(project, sceneId);

  if (target.status !== 'resolved') {
    return (
      <NotFoundPage
        title={
          target.status === 'missing' ? `No scene "${target.sceneId}"` : 'No scene named in the URL'
        }
        detail="The URL names the scene being edited. It is never guessed at, and never falls back to another scene."
        links={target.available.map((scene) => ({
          to: sceneEditorPath(scene.id),
          label: `${scene.displayName} (${scene.id})`,
        }))}
      />
    );
  }

  // Keyed on the scene id so React discards the whole subtree — and with it the
  // previous session, its RuntimeScene and its selection — when the route
  // changes.
  return <SceneEditorShell key={target.sceneId} scene={target.scene} />;
}

function SceneEditorShell({ scene }: { scene: SceneDefinition }): JSX.Element {
  const project = useChamber((state) => state.canonicalProject);
  const handle = useSceneSession(project, scene);
  const runtime = useSceneRuntime(project, handle.scene);
  const registry = browserPrefabRegistry();

  const [selection, setSelection] = useState<SceneSelection>({ kind: 'scene', sceneId: scene.id });
  // Gizmo tool and transform space are viewport presentation, not scene data:
  // switching between Move and Rotate changes nothing about the document.
  const [mode, setMode] = useState<GizmoMode>('translate');
  const [space, setSpace] = useState<TransformSpace>('world');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [renderIssues, setRenderIssues] = useState<RenderProjectionIssue[]>([]);

  const rows = useMemo(
    () => sceneHierarchyRows({ scene: handle.scene, registry }),
    [handle.scene, registry],
  );

  const staged = handle.session.stagedPaths;
  const instanceId = operationTarget(selection);
  const selectedRow = instanceId ? hierarchyRowFor(rows, instanceId) : undefined;
  const selectedInstance = instanceId
    ? handle.scene.gameObjects?.find((gameObject) => gameObject.id === instanceId)
    : undefined;

  const onRenderIssues = useCallback((issues: RenderProjectionIssue[]) => {
    setRenderIssues(issues);
  }, []);

  const toggleExpanded = (id: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="scene-editor" data-testid="scene-editor">
      <header className="scene-toolbar" data-testid="scene-toolbar">
        <span className="target-header__kind">Scene Editor</span>
        <span data-testid="scene-target-name">{handle.scene.displayName}</span>
        <span data-testid="scene-target-id">ID: {scene.id}</span>
        <span data-testid="scene-base-revision">Base revision: {handle.session.baseRevisionId}</span>
        {/*
          The repository's revision, beside the session's own.

          These two disagreeing *is* the defect this pair exists to make
          visible: an Apply used to move the session's private baseline and
          leave the application's canonical project behind, which nothing on
          screen revealed until a route change rebuilt the page from the stale
          one. Two numbers that must always match are much harder to get wrong
          than one number nobody can see.
        */}
        <span data-testid="scene-repository-revision">
          Repository revision: {project.revisionId}
        </span>
        {(['translate', 'rotate', 'scale'] as const).map((tool) => (
          <button
            key={tool}
            type="button"
            className={mode === tool ? 'is-active' : ''}
            onClick={() => setMode(tool)}
            data-testid={`scene-tool-${tool}`}
          >
            {tool === 'translate' ? 'Move' : tool === 'rotate' ? 'Rotate' : 'Scale'}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSpace(space === 'world' ? 'local' : 'world')}
          data-testid="scene-transform-space"
        >
          {space === 'world' ? 'World' : 'Local'}
        </button>
        <button type="button" onClick={handle.undo} disabled={!handle.session.canUndo}>
          Undo
        </button>
        <button type="button" onClick={handle.redo} disabled={!handle.session.canRedo}>
          Redo
        </button>
        <button type="button" onClick={handle.stageAll} data-testid="scene-stage-all">
          Stage all
        </button>
        <button type="button" onClick={handle.revert} data-testid="scene-revert">
          Revert preview
        </button>
        <button
          type="button"
          onClick={() => void handle.apply(`Scene edit: ${scene.id}`)}
          disabled={staged.length === 0 || handle.applying}
          data-testid="scene-apply"
          title={
            staged.length === 0
              ? 'Nothing is staged. Stage the changes you want written first.'
              : 'Validate and write the staged operations to the repository'
          }
        >
          {handle.applying ? 'Applying…' : 'Apply to Repository'}
        </button>
        <span data-testid="scene-dirty-state">{stateLabel(handle, staged.length)}</span>
        {handle.lastApply && (
          <span data-testid="scene-apply-result" className="scene-toolbar__apply">
            {applyLabel(handle.lastApply)}
          </span>
        )}
      </header>

      <aside className="scene-hierarchy" data-testid="scene-hierarchy">
        <button
          type="button"
          className={selection.kind === 'scene' ? 'is-active' : ''}
          onClick={() => setSelection({ kind: 'scene', sceneId: scene.id })}
        >
          ▼ {handle.scene.displayName}
        </button>
        <ul>
          {rows.map((row) => (
            <HierarchyRow
              key={row.instanceId}
              row={row}
              selectedInstanceId={instanceId}
              selectedNodeId={selectedNodeId(selection)}
              expanded={expanded.has(row.instanceId)}
              staged={staged.some((path) => path.startsWith(`/gameObjects/${row.instanceId}`))}
              onToggle={() => toggleExpanded(row.instanceId)}
              onSelectInstance={() =>
                setSelection({
                  kind: 'game-object',
                  sceneId: scene.id,
                  selection: { instanceId: row.instanceId },
                })
              }
              onSelectNode={(nodeId, componentId) =>
                setSelection({
                  kind: 'game-object',
                  sceneId: scene.id,
                  selection: {
                    instanceId: row.instanceId,
                    nodeId,
                    ...(componentId === undefined ? {} : { componentId }),
                  },
                })
              }
            />
          ))}
          {rows.length === 0 && <li data-testid="scene-hierarchy-empty">No GameObjects.</li>}
        </ul>
      </aside>

      <SceneViewport
        scene={handle.scene}
        runtime={runtime}
        selection={selection}
        onSelect={setSelection}
        onCommitTransform={(gameObjectId, transform) =>
          /*
           * Always the root instance id, handed over by the viewport from
           * `operationTarget`. A child runtime node is spelled
           * `<instanceId>/<nodeId>` and naming one here would write an
           * operation against a GameObject that does not exist (§2.5).
           */
          handle.dispatch({ type: 'scene.set_transform', gameObjectId, transform })
        }
        mode={mode}
        space={space}
        onRenderIssues={onRenderIssues}
        onDropPrefab={(payload, point) => {
          /*
           * The drop dispatches the *same* typed command the Asset Panel's
           * place button does. A drop handler that pushed onto
           * `scene.gameObjects` directly would be a second write path with no
           * validation, no protection check and no machine equivalent.
           */
          handle.dispatch({
            type: 'scene.place_prefab',
            gameObjectId: placementGameObjectId(
              payload.prefab.assetId,
              handle.scene.gameObjects ?? [],
            ),
            displayName: payload.displayName,
            prefab: payload.prefab,
            transform: {
              position: point,
              rotation: { ...IDENTITY_ROTATION },
              scale: { ...UNIT_SCALE },
            },
          });
        }}
      />

      <aside className="scene-inspector" data-testid="scene-inspector">
        {selectedInstance && selectedRow ? (
          <GameObjectInspector
            instance={selectedInstance}
            row={selectedRow}
            selection={selection}
            handle={handle}
            onSelect={setSelection}
          />
        ) : (
          <SceneRootInspector scene={handle.scene} handle={handle} />
        )}
        <AssetPanel handle={handle} />
      </aside>

      {(handle.lastIssues.length > 0 || runtime.issues.length > 0 || renderIssues.length > 0) && (
        <ul className="scene-issues" data-testid="scene-issues">
          {handle.lastIssues.map((issue) => (
            <li key={`op:${issue.path}:${issue.message}`}>
              <code>{issue.path}</code> {issue.message}
            </li>
          ))}
          {/*
            Resolver and runtime issues, shown rather than rendered around
            (§4.4). An unknown Prefab version, an abstract Prefab placed, a
            motor with no Animator, an invalid relation — all of them make the
            Scene visibly incomplete, and none of them silently fall back to
            drawing the entity mirror instead.
          */}
          {runtime.issues.map((issue, index) => (
            <li key={`runtime:${issue.code}:${index}`} data-testid="scene-runtime-issue">
              [{issue.severity}] {issue.code}: {issue.message}
            </li>
          ))}
          {renderIssues.map((issue, index) => (
            <li key={`render:${issue.code}:${index}`} data-testid="scene-render-issue">
              [{issue.code}] {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One root instance row, and its resolved Prefab nodes when expanded (§6).
 *
 * The child rows are *inspection* targets. Clicking one selects the node for the
 * Inspector and highlights it in the viewport; it does not turn the node into a
 * Scene instance, and every persistent action stays on the root (§6.2).
 */
function HierarchyRow({
  row,
  selectedInstanceId,
  selectedNodeId: selectedNode,
  expanded,
  staged,
  onToggle,
  onSelectInstance,
  onSelectNode,
}: {
  row: SceneHierarchyRow;
  selectedInstanceId: string | null;
  selectedNodeId: string | null;
  expanded: boolean;
  staged: boolean;
  onToggle: () => void;
  onSelectInstance: () => void;
  onSelectNode: (nodeId: string, componentId?: string) => void;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid={`scene-hierarchy-expand-${row.instanceId}`}
        title="Show the resolved Prefab nodes and their Components"
      >
        {expanded ? '▼' : '▶'}
      </button>
      <button
        type="button"
        className={selectedInstanceId === row.instanceId && selectedNode === null ? 'is-active' : ''}
        onClick={onSelectInstance}
        data-testid={`scene-hierarchy-row-${row.instanceId}`}
      >
        <span>{row.displayName}</span>
        <code data-testid={`scene-hierarchy-prefab-${row.instanceId}`}>
          {row.prefabId}@{row.prefabVersion}
        </code>
      </button>
      {!row.enabled && <em data-testid={`scene-hierarchy-disabled-${row.instanceId}`}>hidden</em>}
      {row.derivation !== 'base' && (
        <span className="badge" data-testid={`scene-hierarchy-derivation-${row.instanceId}`}>
          {row.derivation}
        </span>
      )}
      {row.componentTypes.map((componentType) => (
        <span
          key={componentType}
          className="badge"
          data-testid={`scene-hierarchy-component-${row.instanceId}-${componentType}`}
        >
          {componentType}
        </span>
      ))}
      {row.overrideCount > 0 && (
        <span className="badge" data-testid={`scene-hierarchy-override-${row.instanceId}`}>
          {row.overrideCount} override{row.overrideCount === 1 ? '' : 's'}
        </span>
      )}
      {row.bindingBadge && (
        <span className="badge" data-testid={`scene-hierarchy-binding-${row.instanceId}`}>
          {row.bindingBadge}
        </span>
      )}
      {row.relationBadge && (
        <span className="badge" data-testid={`scene-hierarchy-relation-${row.instanceId}`}>
          {row.relationBadge}
        </span>
      )}
      {row.activeCamera && (
        <span className="badge" data-testid={`scene-hierarchy-active-camera-${row.instanceId}`}>
          active camera
        </span>
      )}
      {staged && <em className="is-staged">staged</em>}
      {row.unresolved && (
        <em data-testid={`scene-hierarchy-unresolved-${row.instanceId}`}>
          {row.unresolvedReason}
        </em>
      )}

      {expanded && (
        <ul data-testid={`scene-hierarchy-nodes-${row.instanceId}`}>
          {row.nodes.map((node) => (
            <li key={node.nodeId} style={{ paddingLeft: `${node.depth * 12}px` }}>
              <button
                type="button"
                className={selectedNode === node.nodeId ? 'is-active' : ''}
                onClick={() => onSelectNode(node.nodeId)}
                data-testid={`scene-hierarchy-node-${row.instanceId}-${node.nodeId}`}
              >
                {node.displayName} <code>{node.nodeId}</code>
              </button>
              {node.nested && (
                <span
                  className="badge"
                  data-testid={`scene-hierarchy-node-nested-${row.instanceId}-${node.nodeId}`}
                >
                  from {node.sourcePrefabId}@{node.sourcePrefabVersion}
                </span>
              )}
              {node.components.map((component) => (
                <button
                  key={component.componentId}
                  type="button"
                  className="badge"
                  onClick={() => onSelectNode(node.nodeId, component.componentId)}
                  data-testid={`scene-hierarchy-node-component-${row.instanceId}-${node.nodeId}-${component.componentType}`}
                >
                  {component.componentType}
                  {component.overridden ? ' •' : ''}
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The one word describing where this session's work currently lives.
 *
 * CONFLICT and INVALID outrank the local states because they are what the human
 * has to act on: a session that showed "STAGED" after a refused Apply would be
 * telling them the work is fine and waiting, when it is neither.
 */
function stateLabel(handle: SceneSessionHandle, stagedCount: number): string {
  const outcome = handle.lastApply;
  if (outcome?.status === 'conflict') return 'CONFLICT';
  if (outcome?.status === 'invalid') return 'INVALID';
  if (outcome?.status === 'rolled-back') return 'ROLLED BACK';
  if (outcome?.status === 'repository-read-only') return 'REPOSITORY READ-ONLY';
  if (outcome?.status === 'unavailable') return 'UNAVAILABLE';
  if (stagedCount > 0) return `STAGED (${stagedCount})`;
  if (handle.session.isDirty) return 'PREVIEW';
  if (outcome?.status === 'applied') return 'APPLIED';
  /*
   * NO CHANGE is its own word, and never APPLIED.
   *
   * The request succeeded and the repository holds exactly what was asked for,
   * but nothing was written — no revision, no report, no file. Rendering that
   * as APPLIED teaches the user that Apply sometimes claims a write it did not
   * make, and once they have seen that they cannot trust the times it did.
   */
  if (outcome?.status === 'no-change') return 'NO CHANGE';
  return 'CLEAN';
}

function applyLabel(outcome: NonNullable<SceneSessionHandle['lastApply']>): string {
  switch (outcome.status) {
    case 'applied':
      return `Applied ${outcome.changedPaths.length} path(s)${outcome.reportPath ? ` · ${outcome.reportPath}` : ''}`;
    case 'no-change':
      return 'No change: the staged operations produce the document already in the repository. Nothing was written.';
    case 'conflict':
      // Named as a conflict rather than a generic failure: the next move is
      // reload-and-reapply, not edit-and-retry.
      return 'Apply refused: the repository moved on. Reload and reapply.';
    case 'invalid':
      return 'Apply refused: the repository rejected the staged operations.';
    case 'rolled-back':
      // Distinct from a refusal: canonical files were touched and put back, so
      // the honest thing to report is that it was undone, not that it never
      // started.
      return `Apply failed part-way and was rolled back; the repository is unchanged.${outcome.transactionId ? ` Transaction ${outcome.transactionId}.` : ''}`;
    case 'repository-read-only':
      // Retrying is the wrong move here and the message has to say so.
      return `Apply failed and the repository could not be certified as restored. It is read-only until a human resolves it.${outcome.transactionId ? ` Transaction ${outcome.transactionId}.` : ''}`;
    case 'unavailable':
      // Never dressed up as a success, and never silently downgraded to a
      // browser-local save.
      return outcome.reason;
  }
}

function SceneRootInspector({
  scene,
  handle,
}: {
  scene: SceneDefinition;
  handle: SceneSessionHandle;
}): JSX.Element {
  return (
    <section data-testid="scene-root-inspector">
      <h2>Scene</h2>
      <dl>
        <dt>Scene ID</dt>
        <dd>{scene.id}</dd>
        <dt>GameObjects</dt>
        <dd data-testid="scene-game-object-count">{(scene.gameObjects ?? []).length}</dd>
        <dt>Active camera</dt>
        <dd data-testid="scene-active-camera">{scene.activeCameraGameObjectId ?? '—'}</dd>
        <dt>Staged paths</dt>
        <dd>{handle.session.stagedPaths.length}</dd>
      </dl>
      <p className="scene-inspector__note">
        Select a GameObject to edit it. Renaming the Scene itself is not a Scene-composition
        operation and is not offered here.
      </p>
    </section>
  );
}

/** The scope a value belongs to, as the label the Inspector shows (§7.1). */
function ScopeLabel({ scope }: { scope: 'shared' | 'instance' | 'runtime' }): JSX.Element {
  const text =
    scope === 'shared' ? 'SHARED PREFAB' : scope === 'instance' ? 'INSTANCE ONLY' : 'RUNTIME ONLY';
  return (
    <span className="badge" data-testid={`scene-scope-${scope}`}>
      {text}
    </span>
  );
}

function GameObjectInspector({
  instance,
  row,
  selection,
  handle,
  onSelect,
}: {
  instance: GameObjectInstanceDefinition;
  row: SceneHierarchyRow;
  selection: SceneSelection;
  handle: SceneSessionHandle;
  onSelect: (selection: SceneSelection) => void;
}): JSX.Element {
  const registry = browserPrefabRegistry();
  const capabilities = handle.capabilities(instance.prefab);
  const nodeId = selectedNodeId(selection);
  const node = nodeId === null ? undefined : row.nodes.find((entry) => entry.nodeId === nodeId);
  /*
   * The Component the override editor edits, chosen by the URL-free selection
   * rather than by position. A node with no Component selected shows the list
   * and no editor — opening one implicitly would put an editable control in
   * front of somebody who only clicked a node.
   */
  const componentId = selection.kind === 'game-object' ? selection.selection.componentId : undefined;
  const selectedComponent =
    componentId === undefined
      ? undefined
      : node?.components.find((entry) => entry.componentId === componentId);
  const versions = registry.versionsOf(instance.prefab.assetId);

  const changePrefabSource = (reference: GameObjectPrefabReference): void => {
    /*
     * The confirmation states which overrides the change drops, computed by the
     * *same* function the operation uses (§7.2). A dialog that listed a
     * different set than the operation clears would be worse than no dialog:
     * the human would sign off on one thing and get another.
     */
    const dropped = overridesClearedByPrefabSourceChange(
      instance,
      handle.capabilities(reference) as PrefabCapabilities | undefined,
    );
    const message =
      dropped.length === 0
        ? `Point "${instance.id}" at ${reference.assetId}@${reference.version}?`
        : `Point "${instance.id}" at ${reference.assetId}@${reference.version}?\n\n` +
          'Node and Component ids belong to the Prefab graph that declared them, so these ' +
          `instance overrides cannot carry across and will be cleared:\n` +
          dropped.map((entry) => `  • ${entry.nodeId} / ${entry.componentId}`).join('\n');
    if (!globalThis.confirm(message)) return;
    handle.dispatch({
      type: 'scene.set_prefab_source',
      gameObjectId: instance.id,
      prefab: reference,
    });
  };

  return (
    <section data-testid="scene-game-object-inspector">
      <h2>{instance.displayName}</h2>
      <dl>
        <dt>GameObject ID</dt>
        <dd data-testid="scene-inspector-instance-id">{instance.id}</dd>
        <dt>Prefab</dt>
        <dd data-testid="scene-inspector-prefab">
          {instance.prefab.assetId}@{instance.prefab.version} <ScopeLabel scope="shared" />
        </dd>
        <dt>Components</dt>
        <dd data-testid="scene-inspector-components">
          {row.componentTypes.join(', ') || '—'} <ScopeLabel scope="shared" />
        </dd>
      </dl>

      <p>
        <Link
          to={prefabEditorPath(
            instance.prefab.assetId,
            ...(node?.components[0] ? ([node.components[0].componentType] as const) : []),
          )}
          data-testid="scene-open-prefab"
        >
          Open “{instance.prefab.assetId}” in the Prefab Editor
        </Link>
      </p>

      <h3>Instance</h3>
      <label>
        Name <ScopeLabel scope="instance" />
        <input
          value={instance.displayName}
          onChange={(event) =>
            handle.dispatch({
              type: 'scene.rename_game_object',
              gameObjectId: instance.id,
              displayName: event.target.value,
            })
          }
          data-testid="scene-inspector-rename"
        />
      </label>

      <label>
        <input
          type="checkbox"
          checked={instance.enabled}
          onChange={(event) =>
            handle.dispatch({
              type: 'scene.set_enabled',
              gameObjectId: instance.id,
              enabled: event.target.checked,
            })
          }
          data-testid="scene-inspector-enabled"
        />
        Enabled <ScopeLabel scope="instance" />
      </label>

      <h3>
        Transform <ScopeLabel scope="instance" />
      </h3>
      {/*
        The *authored* transform, always — never where the simulation has moved
        the object to (§7.1). A CharacterMotor-driven object's live placement is
        RUNTIME ONLY and is deliberately not presented as a saved value; showing
        it here would mean the next tick silently rewrote what the field says.
      */}
      {(['x', 'y', 'z'] as const).map((axis) => (
        <label key={axis}>
          Position {axis}
          <input
            type="number"
            step="0.1"
            value={instance.transform.position[axis]}
            onChange={(event) =>
              handle.dispatch({
                type: 'scene.set_transform',
                gameObjectId: instance.id,
                transform: {
                  ...instance.transform,
                  position: {
                    ...instance.transform.position,
                    [axis]: Number(event.target.value),
                  },
                },
              })
            }
            data-testid={`scene-inspector-position-${axis}`}
          />
        </label>
      ))}

      <h3>Prefab source</h3>
      <select
        value={instance.prefab.version}
        onChange={(event) =>
          changePrefabSource(registry.referenceTo(instance.prefab.assetId, event.target.value))
        }
        data-testid="scene-inspector-prefab-version"
      >
        {versions.map((version) => (
          <option key={version} value={version}>
            {instance.prefab.assetId}@{version}
          </option>
        ))}
      </select>

      {capabilities?.hasCharacterMotor && (
        <>
          <h3>
            Binding <ScopeLabel scope="instance" />
          </h3>
          <select
            value={instance.bindings.characterIntent?.kind ?? 'none'}
            onChange={(event) => {
              const kind = event.target.value;
              handle.dispatch({
                type: 'scene.set_instance_binding',
                gameObjectId: instance.id,
                bindings:
                  kind === 'human'
                    ? { characterIntent: { kind: 'human', playerIndex: 0 } }
                    : kind === 'ai'
                      ? { characterIntent: { kind: 'ai', channelId: 'default' } }
                      : kind === 'none'
                        ? { characterIntent: { kind: 'none' } }
                        : {},
              });
            }}
            data-testid="scene-inspector-binding"
          >
            <option value="">Unbound</option>
            <option value="none">None</option>
            <option value="human">Human (player 0)</option>
            <option value="ai">AI (channel: default)</option>
            {/*
              Script and replay bindings name a track or a recording, so they
              need a picker rather than a bare option that would produce a
              dangling reference. Not built yet.
            */}
            {instance.bindings.characterIntent?.kind === 'script' && (
              <option value="script">Script</option>
            )}
            {instance.bindings.characterIntent?.kind === 'replay' && (
              <option value="replay">Replay</option>
            )}
          </select>
        </>
      )}

      {capabilities?.hasCamera && (
        <>
          <h3>
            Camera <ScopeLabel scope="instance" />
          </h3>
          <select
            value={instance.relations.cameraTargetGameObjectId ?? ''}
            onChange={(event) =>
              handle.dispatch({
                type: 'scene.set_relation',
                gameObjectId: instance.id,
                relations:
                  event.target.value === ''
                    ? {}
                    : { cameraTargetGameObjectId: event.target.value },
              })
            }
            data-testid="scene-inspector-relation"
          >
            <option value="">No target</option>
            {(handle.scene.gameObjects ?? [])
              .filter((candidate) => candidate.id !== instance.id)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.displayName}
                </option>
              ))}
          </select>
          <button
            type="button"
            onClick={() =>
              handle.dispatch({ type: 'scene.set_active_camera', gameObjectId: instance.id })
            }
            data-testid="scene-inspector-set-active-camera"
          >
            Set active camera
          </button>
        </>
      )}

      {node && (
        <section data-testid="scene-inspector-node">
          <h3>
            Node “{node.displayName}” <ScopeLabel scope="shared" />
          </h3>
          <p data-testid="scene-inspector-node-id">
            <code>{node.nodeId}</code> from {node.sourcePrefabId}@{node.sourcePrefabVersion}
          </p>
          {/*
            A child node is inspected here and edited in the Prefab. It is not a
            Scene instance, and no operation on this page names it (§6.2).
          */}
          <p className="scene-inspector__note">
            This is a node of the shared Prefab, shown for inspection. Scene operations address the
            root instance “{instance.id}”.
          </p>
          <ul>
            {node.components.map((component) => (
              <li key={component.componentId}>
                <button
                  type="button"
                  aria-pressed={component.componentId === componentId}
                  onClick={() =>
                    onSelect({
                      kind: 'game-object',
                      sceneId: handle.scene.id,
                      selection: {
                        instanceId: instance.id,
                        nodeId: node.nodeId,
                        componentId: component.componentId,
                      },
                    })
                  }
                  data-testid={`scene-inspector-node-component-${component.componentType}`}
                >
                  {component.componentType}
                </button>
                {component.overridden ? (
                  <>
                    <ScopeLabel scope="instance" />
                    <button
                      type="button"
                      onClick={() =>
                        handle.dispatch({
                          type: 'scene.clear_component_override',
                          gameObjectId: instance.id,
                          nodeId: node.nodeId,
                          componentId: component.componentId,
                        })
                      }
                      data-testid={`scene-inspector-clear-override-${component.componentType}`}
                    >
                      Clear override
                    </button>
                  </>
                ) : (
                  <ScopeLabel scope="shared" />
                )}
              </li>
            ))}
          </ul>

          {selectedComponent && (
            <ComponentOverrideEditor
              instance={instance}
              nodeId={node.nodeId}
              component={selectedComponent}
              handle={handle}
            />
          )}
        </section>
      )}

      {instance.componentOverrides.length > 0 && (
        <>
          <h3>
            Instance overrides <ScopeLabel scope="instance" />
          </h3>
          <button
            type="button"
            onClick={() => {
              // One operation per override rather than a single "revert all"
              // command: the engine's thirteen operations are the whole
              // contract, and a fourteenth that only the UI could produce would
              // be a change no machine could make.
              for (const override of instance.componentOverrides) {
                handle.dispatch({
                  type: 'scene.clear_component_override',
                  gameObjectId: instance.id,
                  nodeId: override.nodeId,
                  componentId: override.componentId,
                });
              }
            }}
            data-testid="scene-inspector-revert-overrides"
          >
            Revert all instance overrides ({instance.componentOverrides.length})
          </button>
        </>
      )}

      <h3>Actions</h3>
      <button
        type="button"
        onClick={() =>
          handle.dispatch({ type: 'scene.duplicate_game_object', gameObjectId: instance.id })
        }
        data-testid="scene-inspector-duplicate"
      >
        Duplicate
      </button>
      <button
        type="button"
        onClick={() =>
          handle.dispatch({ type: 'scene.delete_game_object', gameObjectId: instance.id })
        }
        data-testid={`scene-delete-${instance.id}`}
      >
        Delete
      </button>
      <ReorderControls instance={instance} handle={handle} />
    </section>
  );
}

/**
 * Authoring one Component override, from the Inspector (§3).
 *
 * Three properties are load-bearing and none of them is about the controls.
 *
 * **The target is exact.** `gameObjectId + nodeId + componentId`, all three
 * stable ids the resolver produced. There is no path box: §3.2 forbids
 * arbitrary JSON Pointer editing, so what a human may change is the enumerated
 * table in `component-override-fields.ts` and nothing else.
 *
 * **The scope is stated before the edit, not after.** Every field says whether
 * the value it shows is `OVERRIDDEN HERE` or `INHERITED`, and the section says
 * `INSTANCE ONLY` — because "why did changing this move every other placement
 * of this Prefab?" is a question that must not be answerable in this UI.
 *
 * **An edit merges rather than replaces.** `scene.set_component_override`
 * replaces the whole override for a node/Component pair, so sending only the
 * field just touched would silently drop every other field the instance had
 * already overridden on that Component.
 *
 * The operation target stays the root Scene instance (§3.4). `nodeId` addresses
 * *inside* the resolved Prefab; it is never an operation target of its own.
 */
function ComponentOverrideEditor({
  instance,
  nodeId,
  component,
  handle,
}: {
  instance: GameObjectInstanceDefinition;
  nodeId: string;
  component: SceneHierarchyComponentRow;
  handle: SceneSessionHandle;
}): JSX.Element {
  const [refusal, setRefusal] = useState<string | null>(null);
  const fields = overridableFields(component.definition);
  const existing = instance.componentOverrides.find(
    (override) => override.nodeId === nodeId && override.componentId === component.componentId,
  );

  if (fields.length === 0) {
    return (
      <section data-testid="scene-override-editor-unsupported">
        <h4>Override</h4>
        <p className="scene-inspector__note">
          “{component.componentType}” has no instance-overridable fields. Its payload is a list
          addressed by position, so an override would mean something different the moment the
          Prefab reordered it — that edit belongs to the shared Prefab.
        </p>
      </section>
    );
  }

  const edit = (field: OverrideField, raw: string | boolean): void => {
    const result = patchForField(field, raw);
    if (!result.ok) {
      // Refused before staging, next to the control that was moved. The server
      // re-checks everything and stays authoritative (§3.6).
      setRefusal(result.message);
      return;
    }
    setRefusal(null);
    handle.dispatch({
      type: 'scene.set_component_override',
      gameObjectId: instance.id,
      override: {
        nodeId,
        componentId: component.componentId,
        patches: mergePatch(existing?.patches, result.patch),
      },
    });
  };

  return (
    <section data-testid="scene-override-editor">
      <h4>
        Override “{component.componentType}” <ScopeLabel scope="instance" />
      </h4>
      <p className="scene-inspector__note" data-testid="scene-override-editor-target">
        {instance.id} · {nodeId} · {component.componentId}
      </p>

      {fields.map((field) => {
        const scope = fieldScope(existing?.patches, field);
        const value = fieldValue(component.definition, field);
        const testId = `scene-override-${component.componentType}-${field.path.slice(1)}`;
        return (
          <label key={field.path} data-testid={`${testId}-row`}>
            {field.label}
            {field.kind === 'boolean' && (
              <input
                type="checkbox"
                checked={value === true}
                onChange={(event) => edit(field, event.target.checked)}
                data-testid={testId}
              />
            )}
            {field.kind === 'number' && (
              <input
                type="number"
                value={value === undefined ? '' : String(value)}
                {...(field.min === undefined ? {} : { min: field.min })}
                {...(field.max === undefined ? {} : { max: field.max })}
                {...(field.step === undefined ? {} : { step: field.step })}
                onChange={(event) => edit(field, event.target.value)}
                data-testid={testId}
              />
            )}
            {(field.kind === 'text' || field.kind === 'color') && (
              <input
                type="text"
                value={value === undefined ? '' : String(value)}
                onChange={(event) => edit(field, event.target.value)}
                data-testid={testId}
              />
            )}
            {field.kind === 'enum' && (
              <select
                value={value === undefined ? '' : String(value)}
                onChange={(event) => edit(field, event.target.value)}
                data-testid={testId}
              >
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            )}
            <span
              className="badge"
              data-testid={`${testId}-scope`}
            >
              {scope === 'overridden-here' ? 'OVERRIDDEN HERE' : 'INHERITED'}
            </span>
          </label>
        );
      })}

      {refusal && (
        <p className="scene-inspector__refusal" data-testid="scene-override-refusal">
          {refusal}
        </p>
      )}

      {existing && (
        <button
          type="button"
          onClick={() =>
            handle.dispatch({
              type: 'scene.clear_component_override',
              gameObjectId: instance.id,
              nodeId,
              componentId: component.componentId,
            })
          }
          data-testid="scene-override-clear"
          title="Removes this instance's override; the shared Prefab's values apply again"
        >
          Clear this override
        </button>
      )}
    </section>
  );
}

function ReorderControls({
  instance,
  handle,
}: {
  instance: GameObjectInstanceDefinition;
  handle: SceneSessionHandle;
}): JSX.Element {
  const gameObjects = handle.scene.gameObjects ?? [];
  const index = gameObjects.findIndex((entry) => entry.id === instance.id);
  const move = (toIndex: number): void => {
    handle.dispatch({
      type: 'scene.reorder_game_object',
      gameObjectId: instance.id,
      toIndex,
    });
  };
  return (
    <>
      <button
        type="button"
        disabled={index <= 0}
        onClick={() => move(index - 1)}
        data-testid="scene-inspector-reorder-up"
        title="Declaration order is tick and draw order. Relations are id-based and do not move."
      >
        Move earlier
      </button>
      <button
        type="button"
        disabled={index === -1 || index >= gameObjects.length - 1}
        onClick={() => move(index + 1)}
        data-testid="scene-inspector-reorder-down"
      >
        Move later
      </button>
    </>
  );
}

/**
 * The Asset Panel.
 *
 * It places **Prefabs**, exactly (§11). The categories are filters over
 * Components — "Characters" means Animator + CharacterMotor — and they are not
 * canonical object kinds: a Prefab moves between categories by gaining a
 * Component, not by being reclassified.
 *
 * Placement is by button or by drag, and both dispatch the identical
 * `scene.place_prefab` command carrying the exact id, version and content hash
 * (§8.2). Resolving "latest" at the drop site would place whatever had been
 * published since the panel rendered.
 */
function AssetPanel({ handle }: { handle: SceneSessionHandle }): JSX.Element {
  const registry = browserPrefabRegistry();
  const scenes = useChamber((state) => state.canonicalProject.scenes);
  const [filter, setFilter] = useState<PrefabFilterId>('all');

  const rows = useMemo(() => prefabListRows({ registry, scenes }), [registry, scenes]);
  const visible = useMemo(
    () => filterPrefabRows(rows, filter).filter((row) => !row.abstract && !row.unresolved),
    [rows, filter],
  );

  const place = (reference: GameObjectPrefabReference, displayName: string): void => {
    handle.dispatch({
      type: 'scene.place_prefab',
      gameObjectId: placementGameObjectId(reference.assetId, handle.scene.gameObjects ?? []),
      displayName,
      prefab: reference,
    });
  };

  return (
    <section className="scene-assets" data-testid="scene-asset-panel">
      <h2>Prefabs</h2>
      <div className="scene-assets__filters">
        {PREFAB_FILTERS.filter((entry) => entry !== 'abstract').map((entry) => (
          <button
            key={entry}
            type="button"
            className={filter === entry ? 'is-active' : ''}
            onClick={() => setFilter(entry)}
            data-testid={`scene-asset-filter-${entry}`}
          >
            {PREFAB_FILTER_LABELS[entry]}
          </button>
        ))}
      </div>
      <ul>
        {visible.map((row) => (
          <li key={`${row.prefabId}@${row.version}`}>
            <button
              type="button"
              draggable
              onDragStart={(event) =>
                writeDragPayload(event.dataTransfer, {
                  kind: 'prefab',
                  prefab: row.reference,
                  displayName: row.displayName,
                })
              }
              onClick={() => place(row.reference, row.displayName)}
              data-testid={`scene-place-prefab-${row.prefabId}`}
              title="Drag into the viewport to place it where you point, or click to place it at the origin"
            >
              Place {row.displayName}
            </button>
            <code>
              {row.prefabId}@{row.version}
            </code>
          </li>
        ))}
        {visible.length === 0 && <li data-testid="scene-asset-panel-empty">No Prefabs match.</li>}
      </ul>
      <p className="scene-assets__note">
        Categories are filters over Components, not object kinds. Both placing gestures dispatch the
        same <code>scene.place_prefab</code> command with the exact Prefab version.
      </p>
    </section>
  );
}
