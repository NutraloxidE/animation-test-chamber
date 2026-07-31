/**
 * Save Destination (PLAN 28).
 *
 * The one screen this whole system exists to make possible: a human has just
 * felt something in the chamber, and now has to say *whose* it is. There is no
 * pre-selected option and no default, because every wrong guess here is a
 * shared asset quietly diverging or a character's feel leaking into everyone
 * else's.
 */
import { useState } from 'react';
import { useChamber, type SaveDestinationKind } from '../store.ts';

export function SaveDestinationDialog() {
  const session = useChamber((state) => state.session);
  const options = useChamber((state) => state.saveDestinationOptions)();
  const save = useChamber((state) => state.saveStagedAnimationChanges);
  const close = useChamber((state) => state.openLibraryDialog);
  const backendOnline = useChamber((state) => state.backendOnline);
  useChamber((state) => state.revision);

  const [chosen, setChosen] = useState<SaveDestinationKind | null>(null);
  const [newAssetId, setNewAssetId] = useState('');

  const changes = session.stagedAssetChanges;
  const needsNewId = chosen === 'new-behavior-variant';

  return (
    <div
      className="asset-dialog"
      role="dialog"
      aria-label="Where should this change live?"
      data-testid="save-destination-dialog"
    >
      <h3>Where should this change live?</h3>

      {changes.length === 0 ? (
        <p className="muted" data-testid="save-destination-empty">
          No staged animation changes yet. Tune something in the Chamber and stage it; these are
          the places it could go.
        </p>
      ) : (
        <ul className="save-destination__changes" data-testid="save-destination-changes">
          {changes.slice(0, 8).map((change) => (
            <li key={change.path}>
              <code>{change.path}</code> → {JSON.stringify(change.value)?.slice(0, 60)}
            </li>
          ))}
          {changes.length > 8 && <li className="muted">…and {changes.length - 8} more</li>}
        </ul>
      )}

      {/* The destinations are shown even with nothing staged: what the choices
          *are*, and who each one affects, is the thing worth learning before
          the moment of having to choose one. */}
      <fieldset className="save-destination__options">
        <legend className="visually-hidden">Destination</legend>
        {options.map((option) => (
          <label
            key={option.kind}
            className={`save-destination__option${option.available ? '' : ' is-disabled'}`}
            data-testid={`save-destination-${option.kind}`}
          >
            <input
              type="radio"
              name="save-destination"
              disabled={!option.available}
              checked={chosen === option.kind}
              onChange={() => setChosen(option.kind)}
            />
            <span>
              <strong>{option.label}</strong>
              <em className="save-destination__impact">
                {option.available ? option.impact : option.unavailableReason}
              </em>
            </span>
          </label>
        ))}
      </fieldset>

      {needsNewId && (
        <label>
          New variant id
          <input
            value={newAssetId}
            onChange={(event) => setNewAssetId(event.target.value)}
            placeholder="humanoid-third-person-heavy"
            data-testid="save-destination-new-id"
          />
        </label>
      )}

      {chosen === 'shared-behavior' && (
        <p className="asset-warning" data-testid="save-destination-shared-warning">
          Changing the shared behaviour requires replay verification for every character that
          references it. The transaction runs those before anything is published.
        </p>
      )}

      <div className="asset-dialog__actions">
        <button
          type="button"
          disabled={
            changes.length === 0 ||
            chosen === null ||
            (needsNewId && newAssetId.trim() === '') ||
            (backendOnline === false && chosen !== 'character-override')
          }
          title={
            backendOnline === false
              ? 'Publishing to an asset needs the local API server; a character override still previews here.'
              : undefined
          }
          onClick={() => {
            if (!chosen) return;
            void save({
              kind: chosen,
              ...(needsNewId ? { newAssetId: newAssetId.trim() } : {}),
            });
          }}
          data-testid="save-destination-submit"
        >
          Save here
        </button>
        <button type="button" onClick={() => close(null)} data-testid="save-destination-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}
