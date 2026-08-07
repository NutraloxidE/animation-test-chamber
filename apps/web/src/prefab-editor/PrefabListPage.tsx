/**
 * `/prefabs` — the Prefab inventory (§4).
 *
 * The list the Character list used to be, asking a different question. A
 * Character list could only show Characters; this shows every placeable thing
 * in the repository, and says what each one *is composed of* rather than what
 * category somebody filed it under.
 *
 * Usage counts are here rather than one click in because "how many Scenes stand
 * on this, and how many Prefabs nest it" is what decides whether editing it is
 * a local change or a blast radius — and that has to be visible before the
 * click, not after.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useChamber } from '../store.ts';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { prefabEditorPath, ROUTES } from '../app/routes.ts';
import {
  filterPrefabRows,
  prefabListRows,
  PREFAB_FILTERS,
  PREFAB_FILTER_LABELS,
  type PrefabFilterId,
} from './prefab-list.ts';

export function PrefabListPage(): JSX.Element {
  const scenes = useChamber((state) => state.canonicalProject.scenes);
  const [filter, setFilter] = useState<PrefabFilterId>('all');

  const rows = useMemo(
    () => prefabListRows({ registry: browserPrefabRegistry(), scenes }),
    [scenes],
  );
  const visible = filterPrefabRows(rows, filter);

  return (
    <main className="resource-list prefab-list" data-testid="prefab-list">
      <h1>Prefabs</h1>
      <nav className="prefab-list__filters" data-testid="prefab-list-filters">
        {PREFAB_FILTERS.map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`prefab-filter-${id}`}
            aria-pressed={filter === id}
            className={filter === id ? 'is-active' : undefined}
            onClick={() => setFilter(id)}
          >
            {PREFAB_FILTER_LABELS[id]}
          </button>
        ))}
      </nav>

      {visible.length === 0 ? (
        <p>No Prefab matches this filter.</p>
      ) : (
        <ul>
          {visible.map((row) => (
            <li key={`${row.prefabId}@${row.version}`} data-testid={`prefab-row-${row.prefabId}`}>
              <Link to={prefabEditorPath(row.prefabId)}>{row.displayName}</Link>{' '}
              {/* Id and exact version together: a lineage and a version are two
                  different identities, and the usage counts below belong to the
                  version, not to the lineage. */}
              <code data-testid={`prefab-row-reference-${row.prefabId}`}>
                {row.prefabId}@{row.version}
              </code>
              <span className="prefab-list__derivation">{row.derivation}</span>
              <span className="prefab-list__placement">
                {row.abstract ? 'abstract' : 'placeable'}
              </span>
              <span className="prefab-list__components">
                {row.componentTypes.map((type) => (
                  <span key={type} className="badge">
                    {type}
                  </span>
                ))}
              </span>
              <span
                className="prefab-list__usage"
                data-testid={`prefab-row-usage-${row.prefabId}`}
              >
                {row.sceneUsageCount} scene · {row.nestedUsageCount} nested
              </span>
              {row.unresolved && <span className="badge badge--error">does not resolve</span>}
            </li>
          ))}
        </ul>
      )}

      <p className="resource-list__links">
        <Link to={ROUTES.scenes}>Scenes</Link>
      </p>
    </main>
  );
}
