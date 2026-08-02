/**
 * Dependencies and Used By (PLAN 31).
 *
 * A tree and a list, not a node editor. The two questions that actually block
 * work are "what does this need" and "what breaks if I change it", and both of
 * them have list-shaped answers.
 */
import type { AssetReference } from '@atc/schema';
import { transitiveDependencies, usedBy } from '@atc/animation-asset-runtime';
import { useChamber } from '../store.ts';

export function DependencyView({ reference }: { reference: AssetReference }) {
  const registry = useChamber((state) => state.registry);
  const project = useChamber((state) => state.canonicalProject);
  const select = useChamber((state) => state.selectLibraryAsset);

  const dependencies = transitiveDependencies(registry, reference);
  const holders = usedBy(registry, reference, [project]);

  return (
    <div className="asset-dependencies" data-testid="asset-dependencies">
      <section>
        <h4>Dependencies</h4>
        {dependencies.length === 0 ? (
          <p className="muted" data-testid="asset-dependencies-none">
            None. This asset stands on its own.
          </p>
        ) : (
          <ul data-testid="asset-dependency-list">
            {dependencies.map((dependency) => (
              <li key={`${dependency.assetType}:${dependency.assetId}@${dependency.version}`}>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    select({
                      assetType: dependency.assetType,
                      assetId: dependency.assetId,
                      version: dependency.version,
                    })
                  }
                >
                  {dependency.assetType.replace('animation-', '')} · {dependency.assetId}
                </button>
                <span className="muted"> v{dependency.version}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4>Used by</h4>
        {holders.length === 0 ? (
          <p className="muted" data-testid="asset-usedby-none">
            Nothing references this asset.
          </p>
        ) : (
          <ul data-testid="asset-usedby-list">
            {holders.map((entry, index) => (
              <li key={`${entry.path}-${index}`}>
                {'kind' in entry.holder ? (
                  <>
                    character <strong>{entry.holder.characterId}</strong>
                  </>
                ) : (
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      select({
                        assetType: (entry.holder as AssetReference).assetType,
                        assetId: (entry.holder as AssetReference).assetId,
                        version: (entry.holder as AssetReference).version,
                      })
                    }
                  >
                    {(entry.holder as AssetReference).assetId}
                  </button>
                )}
                <code className="muted"> {entry.path}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
