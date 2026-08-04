/**
 * `/edit/scene/:sceneId` — the Scene Editor shell.
 *
 * Unity-like composition layout: Hierarchy on the left, viewport in the centre,
 * Inspector and Asset Panel sharing the right dock (work package §11.2). It is
 * a separate page from the Rig Editor on purpose — a tab inside the chamber
 * would have had to share the chamber's single-character session, and "which
 * character is this panel about" is exactly the question the split removes.
 *
 * **Phase 7 is partial and says so.** The centre pane is not a 3D viewport yet:
 * there is no renderer, no selection outline, no gizmos and no drag-and-drop
 * placement. Rather than draw a convincing-looking empty canvas, it states what
 * it is. Everything else here is real — the Hierarchy renders the staged scene,
 * the Inspector routes by entity kind, and every edit goes through a typed
 * operation and the shared staging model.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useChamber } from '../store.ts';
import { routeId, sceneEditorPath, rigEditorPath } from '../app/routes.ts';
import { NotFoundPage } from '../app/NotFoundPage.tsx';
import { resolveSceneEditorTarget } from './resolve-scene-editor-target.ts';
import { useSceneSession, type SceneSessionHandle } from './use-scene-session.ts';
import { selectedEntityId, type SceneSelection } from './scene-selection.ts';
import type { SceneDefinition, SceneEntityDefinition } from '@atc/schema';
import type { PlaceableAsset } from '@atc/editor-core';

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
  // previous session and selection — when the route changes.
  return <SceneEditorShell key={target.sceneId} scene={target.scene} />;
}

function SceneEditorShell({ scene }: { scene: SceneDefinition }): JSX.Element {
  const project = useChamber((state) => state.canonicalProject);
  const handle = useSceneSession(project, scene);
  const [selection, setSelection] = useState<SceneSelection>({ kind: 'scene', sceneId: scene.id });

  const staged = handle.session.stagedPaths;
  const entityId = selectedEntityId(selection);
  const selected = entityId
    ? handle.scene.entities.find((entity) => entity.id === entityId)
    : undefined;

  return (
    <div className="scene-editor" data-testid="scene-editor">
      <header className="scene-toolbar" data-testid="scene-toolbar">
        <span className="target-header__kind">Scene Editor</span>
        <span data-testid="scene-target-name">{handle.scene.displayName}</span>
        <span data-testid="scene-target-id">ID: {scene.id}</span>
        <span>Base revision: {handle.session.baseRevisionId}</span>
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
        {/*
          Apply is not wired to the endpoint from this shell yet. It is disabled
          and labelled rather than present-and-silent: a button that only
          changed browser state while saying "Apply" is the exact dishonesty
          §9.4 forbids.
        */}
        <button type="button" disabled title="Not wired from this page yet (Phase 7)">
          Apply to Repository
        </button>
        <span data-testid="scene-dirty-state">
          {staged.length > 0 ? `STAGED (${staged.length})` : handle.session.isDirty ? 'PREVIEW' : 'CLEAN'}
        </span>
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
          {/*
            Rows are navigation, not embedded forms (§11.5). No character
            select, no controller select, no transform inputs — a row answers
            what exists, what is selected, what kind it is and whether it is
            enabled, and the Inspector answers everything else.
          */}
          {handle.scene.entities.map((entity) => (
            <li key={entity.id}>
              <button
                type="button"
                className={entityId === entity.id ? 'is-active' : ''}
                onClick={() => setSelection({ kind: 'entity', sceneId: scene.id, entityId: entity.id })}
                data-testid={`scene-hierarchy-row-${entity.id}`}
              >
                <span className="scene-hierarchy__kind">{kindIcon(entity.kind)}</span>
                <span>{entity.displayName}</span>
                {!entity.enabled && <em>hidden</em>}
                {staged.some((path) => path.startsWith(`/entities/${entity.id}`)) && (
                  <em className="is-staged">staged</em>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="scene-viewport" data-testid="scene-viewport">
        <p>
          The Scene viewport is not implemented yet. Rendering, selection outlines, transform
          gizmos and drag-and-drop placement are Phase 7–8 of the work package.
        </p>
        <p>
          {handle.scene.entities.length} entit
          {handle.scene.entities.length === 1 ? 'y' : 'ies'} in declaration order — which is also
          tick order.
        </p>
      </div>

      <aside className="scene-inspector" data-testid="scene-inspector">
        {selected ? (
          <EntityInspector entity={selected} handle={handle} />
        ) : (
          <SceneRootInspector scene={handle.scene} handle={handle} />
        )}
        <AssetPanel handle={handle} />
      </aside>

      {handle.lastIssues.length > 0 && (
        <ul className="scene-issues" data-testid="scene-issues">
          {handle.lastIssues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <code>{issue.path}</code> {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function kindIcon(kind: SceneEntityDefinition['kind']): string {
  return { character: '🯅', prop: '▧', light: '☀', camera: '🎥' }[kind];
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
      <label>
        Display name
        <input
          value={scene.displayName}
          onChange={(event) =>
            handle.dispatch({ type: 'scene.rename', displayName: event.target.value })
          }
        />
      </label>
      <dl>
        <dt>Scene ID</dt>
        <dd>{scene.id}</dd>
        <dt>Entities</dt>
        <dd>{scene.entities.length}</dd>
        <dt>Active camera</dt>
        <dd>{scene.activeCameraEntityId ?? '—'}</dd>
        <dt>Staged paths</dt>
        <dd>{handle.session.stagedPaths.length}</dd>
      </dl>
    </section>
  );
}

function EntityInspector({
  entity,
  handle,
}: {
  entity: SceneEntityDefinition;
  handle: SceneSessionHandle;
}): JSX.Element {
  return (
    <section data-testid={`scene-entity-inspector-${entity.kind}`}>
      <h2>{entity.displayName}</h2>
      <dl>
        <dt>Entity ID</dt>
        <dd>{entity.id}</dd>
        <dt>Kind</dt>
        <dd>{entity.kind}</dd>
      </dl>

      <label>
        <input
          type="checkbox"
          checked={entity.enabled}
          onChange={(event) =>
            handle.dispatch({
              type: 'scene.set_enabled',
              entityId: entity.id,
              enabled: event.target.checked,
            })
          }
        />
        Enabled
      </label>

      <h3>Transform</h3>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <label key={axis}>
          Position {axis}
          <input
            type="number"
            step="0.1"
            value={entity.transform.position[axis]}
            onChange={(event) =>
              handle.dispatch({
                type: 'scene.set_transform',
                entityId: entity.id,
                transform: {
                  ...entity.transform,
                  position: { ...entity.transform.position, [axis]: Number(event.target.value) },
                },
              })
            }
          />
        </label>
      ))}

      {entity.kind === 'character' && (
        <>
          <h3>Source</h3>
          <p>
            {/*
              Opening the source Character navigates to the Rig Editor. It does
              not edit the Scene, and it does not inline a rig editor here —
              shared rig mappings and animation graphs are not Scene data.
            */}
            <Link to={rigEditorPath(entity.characterId)}>
              Open “{entity.characterId}” in the Rig Editor
            </Link>
          </p>
          <h3>Controller</h3>
          <select
            value={entity.controller.kind}
            onChange={(event) => {
              const kind = event.target.value;
              handle.dispatch({
                type: 'scene.bind_controller',
                entityId: entity.id,
                controller:
                  kind === 'human'
                    ? { kind: 'human', playerIndex: 0 }
                    : kind === 'ai'
                      ? { kind: 'ai', channelId: 'default' }
                      : { kind: 'none' },
              });
            }}
            data-testid={`scene-controller-${entity.id}`}
          >
            <option value="none">None</option>
            <option value="human">Human (player 0)</option>
            <option value="ai">AI (channel: default)</option>
            {/*
              Script and replay bindings name a track or a recording, so they
              need a picker rather than a bare option that would produce a
              dangling reference. Not built yet.
            */}
            {entity.controller.kind === 'script' && <option value="script">Script</option>}
            {entity.controller.kind === 'replay' && <option value="replay">Replay</option>}
          </select>
        </>
      )}

      {entity.kind === 'prop' && (
        <>
          <h3>Asset</h3>
          <code>{JSON.stringify(entity.asset)}</code>
        </>
      )}

      {entity.kind === 'light' && (
        <>
          <h3>Light</h3>
          <dl>
            <dt>Type</dt>
            <dd>{entity.lightType}</dd>
            <dt>Intensity</dt>
            <dd>{entity.intensity}</dd>
            <dt>Colour</dt>
            <dd>{entity.color}</dd>
          </dl>
        </>
      )}

      {entity.kind === 'camera' && (
        <>
          <h3>Camera</h3>
          <dl>
            <dt>Projection</dt>
            <dd>{entity.projection}</dd>
            <dt>Target</dt>
            <dd>{entity.targetEntityId ?? '—'}</dd>
          </dl>
          <button
            type="button"
            onClick={() =>
              handle.dispatch({ type: 'scene.set_active_camera', entityId: entity.id })
            }
          >
            Set active camera
          </button>
        </>
      )}

      <h3>Actions</h3>
      <button
        type="button"
        onClick={() => handle.dispatch({ type: 'scene.duplicate_entity', entityId: entity.id })}
      >
        Duplicate
      </button>
      <button
        type="button"
        onClick={() => handle.dispatch({ type: 'scene.delete_entity', entityId: entity.id })}
        data-testid={`scene-delete-${entity.id}`}
      >
        Delete
      </button>
    </section>
  );
}

/**
 * The Asset Panel.
 *
 * Placement is by button rather than by drag for now — the typed
 * `scene.place_asset` operation is the same either way, which is the point of
 * §4.7: when the drag lands in Phase 8 it dispatches this identical command
 * rather than a second code path.
 *
 * Animation clips, behaviours, tuning profiles and rigs are deliberately absent
 * (§12.1): they are not placeable entities, and offering them would invite a
 * scene that references a clip as if it were a prop.
 */
function AssetPanel({ handle }: { handle: SceneSessionHandle }): JSX.Element {
  const project = useChamber((state) => state.canonicalProject);

  const place = (displayName: string, asset: PlaceableAsset, baseId: string): void => {
    const taken = new Set(handle.scene.entities.map((entity) => entity.id));
    let entityId = baseId;
    for (let index = 2; taken.has(entityId); index += 1) entityId = `${baseId}-${index}`;
    handle.dispatch({ type: 'scene.place_asset', entityId, displayName, asset });
  };

  return (
    <section className="scene-assets" data-testid="scene-asset-panel">
      <h2>Assets</h2>
      <h3>Characters</h3>
      <ul>
        {project.characters.map((character) => (
          <li key={character.id}>
            <button
              type="button"
              onClick={() =>
                place(character.displayName, { kind: 'character', characterId: character.id }, character.id)
              }
              data-testid={`scene-place-character-${character.id}`}
            >
              Place {character.displayName}
            </button>
          </li>
        ))}
      </ul>
      <h3>Create</h3>
      <ul>
        {(['directional', 'point', 'spot'] as const).map((lightType) => (
          <li key={lightType}>
            <button
              type="button"
              onClick={() => place(`${lightType} light`, { kind: 'light', lightType }, `${lightType}-light`)}
            >
              {lightType} light
            </button>
          </li>
        ))}
        <li>
          <button type="button" onClick={() => place('Camera', { kind: 'camera' }, 'camera')}>
            Camera
          </button>
        </li>
      </ul>
      <p className="scene-assets__note">
        Repository prop/model browsing and drag-and-drop placement are Phase 8.
      </p>
    </section>
  );
}
