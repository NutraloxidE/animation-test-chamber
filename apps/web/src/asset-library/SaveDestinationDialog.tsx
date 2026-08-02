/**
 * Save Destination (PLAN Part II §14-16).
 *
 * Graph changes and clip changes are shown, and chosen, separately — a
 * section only appears when that domain actually has staged changes, and
 * submit stays disabled until every domain that has changes also has a
 * destination. There is no pre-selected option and no default: every wrong
 * guess here is a shared asset quietly diverging, a character's feel
 * leaking into everyone else's, or a clip edit silently landing nowhere.
 */
import { useState } from 'react';
import type { ClipDestinationKind, GraphDestinationKind } from '../store.ts';
import { useChamber } from '../store.ts';

export function SaveDestinationDialog() {
  const session = useChamber((state) => state.session);
  const summary = useChamber((state) => state.stagedChangeSummary)();
  const graphOptions = useChamber((state) => state.graphDestinationOptions)();
  const clipOptions = useChamber((state) => state.clipDestinationOptions)();
  const save = useChamber((state) => state.saveStagedAnimationChanges);
  const close = useChamber((state) => state.openLibraryDialog);
  const backendOnline = useChamber((state) => state.backendOnline);
  useChamber((state) => state.revision);

  const [graphChosen, setGraphChosen] = useState<GraphDestinationKind | null>(null);
  const [clipChosen, setClipChosen] = useState<ClipDestinationKind | null>(null);
  const [newAssetId, setNewAssetId] = useState('');

  const changes = session.stagedAssetChanges;
  const hasGraphChanges = summary.graphPatchCount > 0;
  const hasClipChanges = summary.clipChanges.length > 0;
  const hasAnyChanges = hasGraphChanges || hasClipChanges;
  const needsNewId = graphChosen === 'new-behavior-variant';

  const graphSatisfied = !hasGraphChanges || graphChosen !== null;
  const clipSatisfied = !hasClipChanges || clipChosen !== null;
  // A character-override destination is applied locally and never touches the
  // API; any other destination publishes a shared asset and needs it.
  const graphNeedsBackend = hasGraphChanges && graphChosen !== 'character-override';
  const clipNeedsBackend = hasClipChanges && clipChosen !== 'character-override';
  const needsBackend = graphNeedsBackend || clipNeedsBackend;
  const canSubmit =
    hasAnyChanges &&
    !summary.hasUnresolvedClipChanges &&
    graphSatisfied &&
    clipSatisfied &&
    (!needsNewId || newAssetId.trim() !== '') &&
    (backendOnline !== false || !needsBackend);

  const willUpdate: string[] = [];
  const willCreate: string[] = [];
  if (hasGraphChanges && graphChosen) {
    if (graphChosen === 'character-override') willUpdate.push('character instance override');
    else if (graphChosen === 'tuning-profile') willCreate.push('a new tuning profile version');
    else if (graphChosen === 'existing-behavior-variant') willCreate.push('a new version of this behaviour variant');
    else if (graphChosen === 'new-behavior-variant') {
      willCreate.push(newAssetId.trim() ? `new behaviour variant "${newAssetId.trim()}"` : 'a new behaviour variant');
    } else if (graphChosen === 'shared-behavior') willCreate.push('a new version of the shared behaviour');
    willUpdate.push('this character’s behaviour assignment');
  }
  if (hasClipChanges && clipChosen) {
    if (clipChosen === 'character-override') {
      willUpdate.push(`${summary.clipChanges.length} clip override(s) on this character`);
    } else if (clipChosen === 'new-clip-versions-and-motion-set') {
      willCreate.push(`${summary.clipChanges.length} new clip version(s)`, 'a new motion-set version');
      willUpdate.push('this character’s motion-set assignment');
    }
  }

  return (
    <div
      className="asset-dialog"
      role="dialog"
      aria-label="Where should this change live?"
      data-testid="save-destination-dialog"
    >
      <h3>Where should this change live?</h3>

      {!hasAnyChanges ? (
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

      {hasGraphChanges && (
        <fieldset className="save-destination__options" data-testid="save-destination-graph-section">
          <legend>Behaviour changes: {summary.graphPatchCount}</legend>
          {graphOptions.map((option) => (
            <label
              key={option.kind}
              className={`save-destination__option${option.available ? '' : ' is-disabled'}`}
              data-testid={`save-destination-graph-${option.kind}`}
            >
              <input
                type="radio"
                name="save-destination-graph"
                disabled={!option.available}
                checked={graphChosen === option.kind}
                onChange={() => setGraphChosen(option.kind)}
              />
              <span>
                <strong>{option.label}</strong>
                <em className="save-destination__impact">
                  {option.available ? option.impact : option.unavailableReason}
                </em>
              </span>
            </label>
          ))}
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
          {graphChosen === 'shared-behavior' && (
            <p className="asset-warning" data-testid="save-destination-shared-warning">
              Changing the shared behaviour requires replay verification for every character that
              references it. The transaction runs those before anything is published.
            </p>
          )}
        </fieldset>
      )}

      {hasClipChanges && (
        <fieldset className="save-destination__options" data-testid="save-destination-clip-section">
          <legend>
            Clip assets changed: {summary.clipChanges.length}
            <ul className="save-destination__clip-list" data-testid="save-destination-clip-list">
              {summary.clipChanges.map((change) => (
                <li key={change.clipId}>
                  {change.sourceClip
                    ? `${change.sourceClip.assetId}@${change.sourceClip.version}`
                    : `${change.clipId} (no recorded source — cannot save)`}
                </li>
              ))}
            </ul>
          </legend>
          {clipOptions.map((option) => (
            <label
              key={option.kind}
              className={`save-destination__option${option.available ? '' : ' is-disabled'}`}
              data-testid={`save-destination-clip-${option.kind}`}
            >
              <input
                type="radio"
                name="save-destination-clip"
                disabled={!option.available}
                checked={clipChosen === option.kind}
                onChange={() => setClipChosen(option.kind)}
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
      )}

      {summary.hasUnresolvedClipChanges && (
        <p className="asset-warning" data-testid="save-destination-unresolved-warning">
          One or more changed clips have no recorded source asset. This save cannot be submitted
          until that is resolved.
        </p>
      )}

      {(willCreate.length > 0 || willUpdate.length > 0) && (
        <div className="save-destination__preview" data-testid="save-destination-preview">
          {willCreate.length > 0 && (
            <p>
              <strong>Will create:</strong> {willCreate.join(', ')}
            </p>
          )}
          {willUpdate.length > 0 && (
            <p>
              <strong>Will update:</strong> {willUpdate.join(', ')}
            </p>
          )}
          <p className="muted">
            <strong>Will not update automatically:</strong> any other character referencing the
            same asset.
          </p>
        </div>
      )}

      <div className="asset-dialog__actions">
        <button
          type="button"
          disabled={!canSubmit}
          title={
            backendOnline === false && needsBackend
              ? 'Publishing to an asset needs the local API server; a character override still previews here.'
              : undefined
          }
          onClick={() => {
            void save({
              graph: {
                kind: graphChosen ?? 'none',
                ...(needsNewId ? { newAssetId: newAssetId.trim(), displayName: newAssetId.trim() } : {}),
              },
              clips: { kind: clipChosen ?? 'none' },
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
