import { Link } from 'react-router-dom';
import { resolveGameObjectPrefab, type ResolvedPrefabNode } from '@atc/prefab-runtime';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { prefabAnimationWorkspacePath, prefabEditorPath } from '../app/routes.ts';
import { useAnimationChamber } from './useAnimationChamber.ts';

const testId = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '-');

function NodeRow({ node, prefabId, currentNodeId, currentComponentId }: { node: ResolvedPrefabNode; prefabId: string; currentNodeId: string; currentComponentId: string }): JSX.Element {
  return (
    <li data-testid={`animation-node-${testId(node.nodeId)}`}>
      <div><strong>{node.displayName}</strong> <code>{node.nodeId}</code> <span className="badge">{node.enabled ? 'ENABLED' : 'DISABLED'}</span> <span className="badge">{node.nested ? 'INHERITED' : 'LOCAL'}</span></div>
      {node.nested && <small data-testid={`animation-node-source-${testId(node.nodeId)}`}>NESTED SOURCE {node.sourcePrefab.assetId}@{node.sourcePrefab.version}</small>}
      <ul>
        {node.components.map((component) => {
          const current = node.nodeId === currentNodeId && component.componentId === currentComponentId;
          return (
            <li key={component.componentId} data-testid={`animation-component-${testId(component.componentId)}`}>
              <span>{component.componentType} <code>{component.componentId}</code></span> <span className="badge">{node.nested ? 'INHERITED' : 'LOCAL'}</span> {!component.enabled && <span className="badge">DISABLED</span>}
              {current && <span className="badge" data-testid="animation-component-current-subject">CURRENT SUBJECT</span>}
              {node.nested && <span data-testid={`animation-component-source-${testId(component.componentId)}`}> {node.sourcePrefab.assetId}@{node.sourcePrefab.version}</span>}
              {component.componentType === 'animator' ? (
                <Link to={prefabAnimationWorkspacePath(prefabId, node.nodeId, component.componentId)}>{current ? 'Focus Graph' : 'Open exact Animator'}</Link>
              ) : (
                <Link data-testid={`animation-open-prefab-component-${testId(component.componentId)}`} to={`${prefabEditorPath(prefabId)}?node=${encodeURIComponent(node.nodeId)}&component=${encodeURIComponent(component.componentId)}`}>Open in Prefab Editor</Link>
              )}
              {component.componentType === 'animator' && <small> Behavior {component.assignment.behavior.assetId}@{component.assignment.behavior.version} · Motion Set {component.assignment.motionSet.assetId}@{component.assignment.motionSet.version} · Rig {component.assignment.rig.assetId}@{component.assignment.rig.version}</small>}
            </li>
          );
        })}
      </ul>
      {node.children.length > 0 && <ul>{node.children.map((child) => <NodeRow key={child.nodePath} node={child} prefabId={prefabId} currentNodeId={currentNodeId} currentComponentId={currentComponentId} />)}</ul>}
    </li>
  );
}

export function PrefabAnimationHierarchy(): JSX.Element {
  const subject = useAnimationChamber((state) => state.subject);
  const contexts = useAnimationChamber((state) => state.project.motionContextKeys);
  const context = useAnimationChamber((state) => state.motionContextId);
  const setContext = useAnimationChamber((state) => state.setMotionContext);
  const setStatus = useAnimationChamber((state) => state.setStatus);
  const registry = browserPrefabRegistry();
  const resolved = resolveGameObjectPrefab(registry, subject.source.prefab);
  return (
    <aside className="animation-hierarchy" data-testid="animation-hierarchy">
      <header><h3>Prefab Hierarchy</h3><code data-testid="animation-hierarchy-prefab">{subject.source.prefab.assetId}@{subject.source.prefab.version}</code></header>
      <label>Motion context <select data-testid="weapon-mode-select" value={context} onChange={(event) => { setContext(event.target.value); setStatus(`${event.target.options[event.target.selectedIndex]?.text ?? event.target.value} context selected for the exact Animator.`); }}>{contexts.map((id) => <option key={id} value={id}>{id === 'sword' ? 'Sword' : id}</option>)}</select></label>
      <ul><NodeRow node={resolved.prefab.root} prefabId={subject.source.prefab.assetId} currentNodeId={subject.source.nodeId} currentComponentId={subject.source.componentId} /></ul>
    </aside>
  );
}
