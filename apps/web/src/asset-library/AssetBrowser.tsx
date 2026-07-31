/**
 * Asset type filter, facets, search and the result list (PLAN 24.3–24.5).
 *
 * Everything here runs against the in-memory registry the store built from the
 * generated index, so search stays instant and works with no API — which is
 * also what makes the static build genuinely browsable rather than a shell.
 */
import type { AnimationAssetSummary } from '@atc/schema';
import { useChamber } from '../store.ts';

const TYPE_FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'animation-behavior', label: 'Behaviors' },
  { id: 'animation-motion-set', label: 'Motion Sets' },
  { id: 'animation-clip', label: 'Clips' },
  { id: 'humanoid-rig', label: 'Rig Profiles' },
  { id: 'animation-tuning', label: 'Tuning Profiles' },
  { id: 'candidates', label: 'Candidates' },
];

const FACETS: { id: string; label: string }[] = [
  { id: 'all', label: 'Any' },
  { id: 'used-by-active', label: 'Used by active character' },
  { id: 'unused', label: 'Unused' },
  { id: 'variant', label: 'Variant' },
  { id: 'fork', label: 'Fork' },
  { id: 'protected', label: 'Protected' },
  { id: 'invalid', label: 'Invalid' },
];

function AssetCard({ summary }: { summary: AnimationAssetSummary }) {
  const selection = useChamber((state) => state.librarySelection);
  const select = useChamber((state) => state.selectLibraryAsset);
  const canonical = useChamber((state) => state.canonicalProject);

  const referencedBy = canonical.characters.filter((character) =>
    [
      character.animation.behavior,
      character.animation.motionSet,
      character.animation.rig,
      character.animation.tuning,
    ].some((reference) => reference?.assetId === summary.id),
  ).length;

  const selected =
    selection?.assetId === summary.id && selection.version === summary.version;

  return (
    <li>
      <button
        type="button"
        className={`asset-card${selected ? ' is-selected' : ''}${summary.valid ? '' : ' is-invalid'}`}
        data-testid={`asset-card-${summary.id}`}
        onClick={() =>
          select({
            assetType: summary.assetType,
            assetId: summary.id,
            version: summary.version,
          })
        }
      >
        <span className="asset-card__name">{summary.displayName}</span>
        <span className="asset-card__meta">
          <code>{summary.id}</code>
          <span className="asset-card__version">v{summary.version}</span>
        </span>
        <span className="asset-card__badges">
          <span className="asset-badge">{summary.assetType.replace('animation-', '')}</span>
          {summary.derivation !== 'base' && (
            <span className="asset-badge asset-badge--derivation">{summary.derivation}</span>
          )}
          {summary.protectionLevel !== 'editable' && (
            <span className="asset-badge asset-badge--protected">{summary.protectionLevel}</span>
          )}
          <span
            className={`asset-badge asset-badge--${summary.valid ? 'valid' : 'invalid'}`}
            data-testid={`asset-validity-${summary.id}`}
          >
            {summary.valid ? 'valid' : summary.issueCodes[0] ?? 'invalid'}
          </span>
          <span className="asset-badge asset-badge--refs">
            {referencedBy} character{referencedBy === 1 ? '' : 's'}
          </span>
        </span>
        {summary.tags.length > 0 && (
          <span className="asset-card__tags">{summary.tags.join(' · ')}</span>
        )}
      </button>
    </li>
  );
}

export function AssetTypeFilter() {
  const typeFilter = useChamber((state) => state.libraryTypeFilter);
  const setTypeFilter = useChamber((state) => state.setLibraryTypeFilter);
  const facet = useChamber((state) => state.libraryFacet);
  const setFacet = useChamber((state) => state.setLibraryFacet);

  return (
    <nav className="asset-types" data-testid="asset-type-filter">
      <h3>Type</h3>
      <ul>
        {TYPE_FILTERS.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={typeFilter === entry.id ? 'is-active' : ''}
              onClick={() => setTypeFilter(entry.id)}
              data-testid={`asset-type-${entry.id}`}
            >
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
      <h3>Filter</h3>
      <ul>
        {FACETS.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              className={facet === entry.id ? 'is-active' : ''}
              onClick={() => setFacet(entry.id)}
              data-testid={`asset-facet-${entry.id}`}
            >
              {entry.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The candidate list, shown when the Candidates type filter is selected. */
function CandidateList() {
  const candidates = useChamber((state) => state.canonicalProject.candidates);
  const promote = useChamber((state) => state.promoteCandidateToClip);
  const backendOnline = useChamber((state) => state.backendOnline);

  if (candidates.length === 0) {
    return (
      <p className="muted" data-testid="asset-candidates-empty">
        No acquisition candidates. Import one from the Chamber’s Assets panel.
      </p>
    );
  }

  return (
    <ul className="asset-list" data-testid="asset-candidate-list">
      {candidates.map((candidate) => {
        // Promotion is gated on human acceptance, and the button says so rather
        // than failing at the server with a message nobody was looking at.
        const accepted = candidate.state === 'HumanAccepted';
        return (
          <li key={candidate.id}>
            <div className="asset-card asset-card--static">
              <span className="asset-card__name">{candidate.id}</span>
              <span className="asset-card__meta">
                <span className="asset-badge">{candidate.state}</span>
                <span className="muted">{candidate.durationSec.toFixed(2)}s</span>
              </span>
              <button
                type="button"
                disabled={!accepted || backendOnline === false}
                data-testid={`promote-candidate-${candidate.id}`}
                title={
                  !accepted
                    ? `Only a HumanAccepted candidate may become a clip asset (this one is ${candidate.state}).`
                    : backendOnline === false
                      ? 'Publishing needs the local API server.'
                      : 'Promote to a clip asset'
                }
                onClick={() => void promote(candidate.id)}
              >
                Promote to clip asset
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function AssetBrowser() {
  const search = useChamber((state) => state.librarySearch);
  const setSearch = useChamber((state) => state.setLibrarySearch);
  const typeFilter = useChamber((state) => state.libraryTypeFilter);
  // Subscribing to the facet matters: `librarySummaries` is a stable function,
  // so a facet change alone would not re-render this list without it.
  useChamber((state) => state.libraryFacet);
  useChamber((state) => state.activeCharacterId);
  useChamber((state) => state.revision);
  const summaries = useChamber((state) => state.librarySummaries)();

  return (
    <div className="asset-browser" data-testid="asset-browser">
      <label className="asset-search">
        <span className="visually-hidden">Search assets</span>
        <input
          type="search"
          value={search}
          placeholder="Search name, id, tag, slot, state, event"
          onChange={(event) => setSearch(event.target.value)}
          data-testid="asset-search"
        />
      </label>

      {typeFilter === 'candidates' ? (
        <CandidateList />
      ) : summaries.length === 0 ? (
        <p className="muted" data-testid="asset-list-empty">
          Nothing matches. Clear the search or pick a different filter.
        </p>
      ) : (
        <ul className="asset-list" data-testid="asset-list">
          {summaries.map((summary) => (
            <AssetCard key={`${summary.assetType}:${summary.id}@${summary.version}`} summary={summary} />
          ))}
        </ul>
      )}
    </div>
  );
}
