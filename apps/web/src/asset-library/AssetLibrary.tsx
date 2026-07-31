/**
 * The Asset Library workspace (PLAN 24).
 *
 * Three panes on a desktop, one at a time at 320px. The narrow layout is a
 * drill-down rather than a squeeze — Type list, then Asset list, then Detail —
 * because three columns of asset metadata at 320px is unreadable however
 * carefully it is scaled.
 */
import { useState } from 'react';
import { useChamber } from '../store.ts';
import { AssetBrowser, AssetTypeFilter } from './AssetBrowser.tsx';
import { AssetDetail } from './AssetDetail.tsx';
import { ApplyAssetDialog, DeriveAssetDialog } from './ApplyAssetDialog.tsx';
import { SaveDestinationDialog } from './SaveDestinationDialog.tsx';

type NarrowPane = 'types' | 'list' | 'detail';

export function AssetLibrary() {
  const selection = useChamber((state) => state.librarySelection);
  const dialog = useChamber((state) => state.libraryDialog);
  const assetIssues = useChamber((state) => state.assetIssues);
  const backendOnline = useChamber((state) => state.backendOnline);
  const characters = useChamber((state) => state.canonicalProject.characters);
  const activeCharacterId = useChamber((state) => state.activeCharacterId);
  const setActiveCharacter = useChamber((state) => state.setActiveCharacter);

  // The narrow layout needs somewhere to remember how deep the reader is. The
  // selection alone cannot say it: picking an asset and then going back to the
  // list are different states with the same selection.
  const [narrowPane, setNarrowPane] = useState<NarrowPane>('types');

  const errors = assetIssues.filter((issue) => issue.severity === 'error');

  return (
    <div className="asset-library" data-testid="asset-library" data-pane={narrowPane}>
      <header className="asset-library__bar">
        <label className="asset-library__character">
          Character
          <select
            value={activeCharacterId}
            onChange={(event) => setActiveCharacter(event.target.value)}
            data-testid="library-character-select"
          >
            {characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.displayName}
              </option>
            ))}
          </select>
        </label>
        {backendOnline === false && (
          <span className="asset-library__static" data-testid="asset-library-static-badge">
            Read-only: no API server
          </span>
        )}
      </header>

      {errors.length > 0 && (
        <ul className="asset-issues" data-testid="asset-library-errors">
          {errors.map((issue, index) => (
            <li key={index}>
              <strong>{issue.code}</strong> {issue.message}
            </li>
          ))}
        </ul>
      )}

      <nav className="asset-library__crumbs" data-testid="asset-library-crumbs">
        <button
          type="button"
          className={narrowPane === 'types' ? 'is-active' : ''}
          onClick={() => setNarrowPane('types')}
          data-testid="library-pane-types"
        >
          Types
        </button>
        <button
          type="button"
          className={narrowPane === 'list' ? 'is-active' : ''}
          onClick={() => setNarrowPane('list')}
          data-testid="library-pane-list"
        >
          Assets
        </button>
        <button
          type="button"
          className={narrowPane === 'detail' ? 'is-active' : ''}
          disabled={!selection}
          onClick={() => setNarrowPane('detail')}
          data-testid="library-pane-detail"
        >
          Detail
        </button>
      </nav>

      <div className="asset-library__panes">
        <aside className="asset-library__pane asset-library__pane--types">
          <AssetTypeFilter />
        </aside>
        <section
          className="asset-library__pane asset-library__pane--list"
          onClick={() => setNarrowPane('detail')}
        >
          <AssetBrowser />
        </section>
        <section className="asset-library__pane asset-library__pane--detail">
          <AssetDetail />
        </section>
      </div>

      {dialog === 'apply' && <ApplyAssetDialog />}
      {dialog === 'derive' && <DeriveAssetDialog />}
      {dialog === 'save-destination' && <SaveDestinationDialog />}
    </div>
  );
}
