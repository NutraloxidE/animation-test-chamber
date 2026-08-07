import { Link } from 'react-router-dom';
import { prefabAnimationWorkspacePath, ROUTES } from '../app/routes.ts';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { prefabAnimatorLocations } from './resolve-prefab-editor-target.ts';

/** Every exact Animator workspace currently available in the repository. */
export function RigEditorListPage(): JSX.Element {
  const registry = browserPrefabRegistry();
  const rows = registry.summaries().flatMap((prefab) => {
    const version = registry.latestVersion(prefab.id)!;
    const reference = registry.referenceTo(prefab.id, version);
    return prefabAnimatorLocations(registry, reference).map((animator) => ({ prefab, animator }));
  });

  return (
    <main className="resource-list" data-testid="rig-editor-list">
      <h1>Rig Editor</h1>
      <p>編集するPrefabのAnimatorを選択してください。</p>
      {rows.length === 0 ? (
        <p data-testid="rig-editor-list-empty">編集可能なAnimatorはありません。</p>
      ) : (
        <ul>
          {rows.map(({ prefab, animator }) => (
            <li
              key={`${prefab.id}:${animator.nodeId}:${animator.componentId}`}
              data-testid={`rig-editor-row-${prefab.id}-${animator.nodeId}-${animator.componentId}`}
            >
              <Link
                to={prefabAnimationWorkspacePath(
                  prefab.id,
                  animator.nodeId,
                  animator.componentId,
                )}
              >
                {prefab.displayName} — {animator.nodeDisplayName}
              </Link>{' '}
              <code>
                {prefab.id}@{prefab.version} / {animator.nodeId} / {animator.componentId}
              </code>
            </li>
          ))}
        </ul>
      )}
      <p className="resource-list__links">
        <Link to={ROUTES.prefabs}>すべてのPrefabsを見る</Link>
      </p>
    </main>
  );
}
