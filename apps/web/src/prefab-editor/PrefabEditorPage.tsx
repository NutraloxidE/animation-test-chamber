/**
 * `/edit/prefab/:prefabId` — the composition editor (§4).
 *
 * The route parameter is authoritative. An unknown id is a not-found; it never
 * falls back to the first Prefab, because a page that always renders *something*
 * is a page that can be editing the wrong asset while looking entirely correct.
 *
 * The panels are the Prefab's own structure rather than a Character's tabs:
 *
 *   Hierarchy           the resolved node tree, and which Prefab contributed each node
 *   Components          the selected node's Components
 *   Component Inspector the selected Component's authored values
 *   Viewport            the composition, drawn through `GameObjectRenderer`
 *   Usage               exact Scene instances and Prefab holders of this version
 *   Dependencies        every asset this Prefab needs, transitively
 *   Version             derivation, parent and patches
 *
 * Selection is view state and lives in the URL's query string, never in the
 * document: opening a Component must not stage an edit, and `?component=animator`
 * is what makes the legacy Rig redirect able to land on the Animator directly.
 *
 * Preview overrides are deliberately absent from this file. A preview that
 * wrote anywhere the document can see would stop being a preview, and the one
 * place §4 allows it — transient, `nodeId + componentId + patch`, gone on route
 * change — is exactly what local component state already is.
 */
import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { GameObjectComponentDefinition } from '@atc/schema';
import {
  describePrefabUsage,
  resolveGameObjectPrefab,
  walkResolvedNodes,
  type ResolvedPrefabNode,
} from '@atc/prefab-runtime';
import { useChamber } from '../store.ts';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { NotFoundPage } from '../app/NotFoundPage.tsx';
import { prefabAnimationWorkspacePath, prefabEditorPath, ROUTES, routeId } from '../app/routes.ts';
import { prefabParentReference, resolvePrefabEditorTarget } from './resolve-prefab-editor-target.ts';
import { PrefabOverview } from './PrefabOverview.tsx';
import { PrefabViewport } from './PrefabViewport.tsx';
import { gameplayScriptRegistry } from '@atc/gameplay';

/** One row of the resolved tree. Nested nodes say where they came from. */
function HierarchyRow({
  node,
  depth,
  selectedNodeId,
  onSelect,
}: {
  node: ResolvedPrefabNode;
  depth: number;
  selectedNodeId: string;
  onSelect: (nodeId: string) => void;
}): JSX.Element {
  return (
    <>
      <li style={{ paddingLeft: `${depth * 12}px` }}>
        <button
          type="button"
          data-testid={`prefab-node-${node.nodeId}`}
          aria-pressed={node.nodeId === selectedNodeId}
          onClick={() => onSelect(node.nodeId)}
        >
          {node.displayName} <code>{node.nodeId}</code>
        </button>
        {node.nested && (
          <span className="badge" data-testid={`prefab-node-nested-${node.nodeId}`}>
            from {node.sourcePrefab.assetId}@{node.sourcePrefab.version}
          </span>
        )}
      </li>
      {node.children.map((child) => (
        <HierarchyRow
          key={child.nodePath}
          node={child}
          depth={depth + 1}
          selectedNodeId={selectedNodeId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

/**
 * The selected Component's authored values.
 *
 * An Animator's inspector opens the *existing* animation authoring workspace
 * rather than reimplementing it: the graph, the motion sets and the tuning
 * already have a screen, and a second editor for the same assets would be a
 * second answer to what a behaviour does.
 */
function ComponentInspector({
  component,
}: {
  component: GameObjectComponentDefinition | undefined;
}): JSX.Element {
  if (!component) return <p data-testid="prefab-component-inspector-empty">No Component selected.</p>;

  return (
    <div data-testid="prefab-component-inspector">
      <h4>
        {component.componentType} <code>{component.componentId}</code>
      </h4>
      {component.componentType === 'animator' && (
        <p data-testid="prefab-animator-assignment">
          {component.assignment.behavior.assetId}@{component.assignment.behavior.version} ·{' '}
          {component.assignment.motionSet.assetId}@{component.assignment.motionSet.version} ·{' '}
          {component.assignment.rig.assetId}@{component.assignment.rig.version}
        </p>
      )}
      {component.componentType === 'script' && (() => {
        const entry = gameplayScriptRegistry.find(component.script);
        const mismatch = entry && entry.reference.contentHash !== component.script.contentHash;
        if (!entry || mismatch) return <p data-testid="prefab-script-unavailable">Script unavailable: {component.script.assetId}@{component.script.version} {mismatch ? 'hash mismatch' : 'not found'}</p>;
        return (
          <div data-testid="prefab-script-properties">
            <p>{component.script.assetId}@{component.script.version} <code>{component.script.contentHash}</code></p>
            {Object.entries(entry.definition.properties).map(([key, descriptor]) => (
              <label key={key}>{key}<input readOnly value={String(component.properties[key] ?? '')} data-kind={descriptor.kind} /></label>
            ))}
          </div>
        );
      })()}
      <pre data-testid="prefab-component-values">{JSON.stringify(component, null, 2)}</pre>
    </div>
  );
}

export function PrefabEditorPage(): JSX.Element {
  const prefabId = routeId(useParams().prefabId);
  const scenes = useChamber((state) => state.canonicalProject.scenes);
  const [search, setSearch] = useSearchParams();
  const registry = browserPrefabRegistry();

  const target = resolvePrefabEditorTarget(registry, prefabId);

  const resolution = useMemo(
    () =>
      target.status === 'resolved'
        ? resolveGameObjectPrefab(registry, target.reference)
        : undefined,
    [registry, target.status, target.status === 'resolved' ? target.reference.contentHash : null],
  );

  const usage = useMemo(() => {
    if (target.status !== 'resolved') return undefined;
    const key = `${target.reference.assetId}@${target.reference.version}`;
    return describePrefabUsage({ prefabRegistry: registry, scenes }).find(
      (entry) => `${entry.prefab.assetId}@${entry.prefab.version}` === key,
    );
  }, [registry, scenes, target.status, target.status === 'resolved' ? target.reference.contentHash : null]);

  if (target.status !== 'resolved' || !resolution) {
    const available = target.status === 'resolved' ? [] : target.available;
    return (
      <NotFoundPage
        title={
          target.status === 'missing'
            ? `No Prefab "${target.prefabId}"`
            : 'No Prefab named in the URL'
        }
        detail="The URL names the Prefab being edited. It is never guessed at, and never falls back to another Prefab."
        links={[
          { to: ROUTES.prefabs, label: 'Prefabs' },
          ...available
            .slice(0, 8)
            .map((summary) => ({
              to: prefabEditorPath(summary.id),
              label: `${summary.displayName} (${summary.id})`,
            })),
        ]}
      />
    );
  }

  const parentReference = prefabParentReference(target.document);
  const nodes = walkResolvedNodes(resolution.prefab.root);
  const selectedNodeId = search.get('node') ?? resolution.prefab.root.nodeId;
  const selectedNode = nodes.find((node) => node.nodeId === selectedNodeId) ?? resolution.prefab.root;
  /*
   * `?component=` names a Component **id**, not a type (§7.2).
   *
   * A node may carry two Animators, and selecting by type would open whichever
   * came first — the same "pick something plausible" failure the exact route
   * exists to refuse, one level down. The id match is tried first; the type
   * match that follows is a compatibility path for URLs written before this
   * change, and it only settles for a type when no Component has that id.
   */
  const selectedComponentKey = search.get('component');
  const selectedComponent =
    selectedNode.components.find((component) => component.componentId === selectedComponentKey) ??
    selectedNode.components.find((component) => component.componentType === selectedComponentKey) ??
    selectedNode.components[0];
  /*
   * The workspace opens only when the URL *names* the Animator, not merely when
   * an Animator happens to be the node's first Component. Opening a Prefab
   * should show the Prefab; the workspace is somewhere you navigate to, and the
   * legacy rig redirect is what navigates there.
   */

  const select = (patch: Record<string, string>): void => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(patch)) next.set(key, value);
    setSearch(next, { replace: true });
  };

  return (
    <div className="prefab-editor" data-testid="prefab-editor">
      <header className="target-header" data-testid="prefab-target-header">
        <span className="target-header__kind">Prefab Editor</span>
        <span className="target-header__name" data-testid="prefab-target-name">
          {resolution.prefab.displayName}
        </span>
        <span className="target-header__id" data-testid="prefab-target-id">
          ID: {target.prefabId}@{target.version}
        </span>
        <nav className="target-header__switch">
          <Link to={ROUTES.prefabs}>All Prefabs</Link>
        </nav>
      </header>

      <PrefabOverview resolved={resolution.prefab} document={target.document} usage={usage} />

      {resolution.issues.length > 0 && (
        <ul className="prefab-editor__issues" data-testid="prefab-editor-issues">
          {resolution.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              [{issue.severity}] {issue.code}: {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="prefab-editor__panels">
        <section data-testid="prefab-hierarchy-panel">
          <h3>Hierarchy</h3>
          <ul>
            <HierarchyRow
              node={resolution.prefab.root}
              depth={0}
              selectedNodeId={selectedNodeId}
              onSelect={(nodeId) => select({ node: nodeId })}
            />
          </ul>
        </section>

        <section data-testid="prefab-components-panel">
          <h3>Components</h3>
          <ul>
            {selectedNode.components.map((component) => (
              <li key={component.componentId}>
                <button
                  type="button"
                  data-testid={`prefab-component-${component.componentId}`}
                  data-component-type={component.componentType}
                  aria-pressed={component.componentId === selectedComponent?.componentId}
                  onClick={() => select({ component: component.componentId })}
                >
                  {component.componentType} <code>{component.componentId}</code>
                </button>
                {component.componentType === 'animator' && (
                  /*
                   * The way into the workspace. It names all three ids, so the
                   * destination is this Animator rather than whichever one the
                   * Prefab happens to resolve first.
                   */
                  <Link
                    data-testid={`prefab-open-animation-workspace-${component.componentId}`}
                    to={prefabAnimationWorkspacePath(
                      target.prefabId,
                      selectedNode.nodeId,
                      component.componentId,
                    )}
                  >
                    Open Animation Workspace
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section data-testid="prefab-inspector-panel">
          <h3>Component Inspector</h3>
          <ComponentInspector component={selectedComponent} />
        </section>

        <section data-testid="prefab-viewport-panel">
          <h3>Viewport</h3>
          <PrefabViewport reference={target.reference} />
        </section>

        <section data-testid="prefab-usage-panel">
          <h3>Usage</h3>
          <ul>
            {(usage?.sceneInstances ?? []).map((instance) => (
              <li key={`${instance.sceneId}/${instance.gameObjectId}`}>
                {instance.sceneId} / {instance.gameObjectId}
              </li>
            ))}
            {(usage?.sceneInstances ?? []).length === 0 && <li>No Scene stands on this version.</li>}
          </ul>
        </section>

        <section data-testid="prefab-dependencies-panel">
          <h3>Dependencies</h3>
          <ul>
            {resolution.prefab.dependencies.map((dependency) => (
              <li key={`${dependency.assetType}:${dependency.assetId}@${dependency.version}`}>
                {dependency.assetType} {dependency.assetId}@{dependency.version}
              </li>
            ))}
            {resolution.prefab.dependencies.length === 0 && <li>None.</li>}
          </ul>
        </section>

        <section data-testid="prefab-version-panel">
          <h3>Version</h3>
          <p data-testid="prefab-version-derivation">
            {target.prefabId}@{target.version} — {target.document.derivation.mode}
            {parentReference !== undefined &&
              ` of ${parentReference.assetId}@${parentReference.version}`}
          </p>
          <p>
            Versions: {registry.versionsOf(target.prefabId).join(', ')}
          </p>
        </section>
      </div>

      {selectedComponentKey === '__native-workspace-is-route-only__' && (<></>
        /*
         * The authoring workspace, mounted in place. It still runs off the
         * animation subject the store holds — the Component's assignment is
         * what names the assets it edits — so opening it here is a link into
         * one workspace, not a second one.
         */
        )}

        {/*
        One viewport at a time. The animation workspace brings its own — two
        live WebGL canvases on one page compete for the same software
        rasteriser, and the Prefab preview has nothing to add while the
        workspace is showing the same composition animating.
        */}
    </div>
  );
}
