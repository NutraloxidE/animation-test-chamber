/**
 * Where a staged animation change goes, named exactly.
 *
 * This is the donor's Save Destination with its semantics replaced. The layout
 * and the information density are preservation targets — the human still sees
 * the staged changes, the domains involved, the destination choice, what will
 * be created, what will be updated and what will deliberately not be — but
 * every label that named a Character is gone, because a Character is not a
 * destination in this workspace and never was one for these assets.
 *
 * "character override", "this character" and "shared Character behaviour" are
 * replaced by the only things that can actually be written: a new immutable
 * animation asset version, and the exact Prefabs that adopt it.
 *
 * Nothing is pre-selected. That is not a UX preference — an adoption defaulted
 * to "the current holder" is a blast radius nobody chose, and one defaulted to
 * "all holders" is worse.
 */
import { useState } from 'react';
import { describeOwner } from './animation-publication-state.ts';
import { useAnimationChamber } from './useAnimationChamber.ts';
import { useAnimationPublication } from './useAnimationPublication.ts';
import { OFFLINE_PUBLICATION_MESSAGE } from './AnimationPublicationController.ts';

export function AnimationSaveDestination(): JSX.Element {
  const controller = useAnimationChamber((state) => state.publication);
  const view = useAnimationPublication();
  const [intent, setIntent] = useState('');

  if (view.stage === 'closed') return <></>;

  const chosen = view.stage !== 'choosing';
  const blocked = view.blocking.length > 0;
  const offline = view.backendOnline === false;
  const plan = view.plan;

  return (
    <section
      className="asset-dialog save-destination"
      role="dialog"
      aria-label="Where should this change be published?"
      data-testid="animation-save-destination"
      data-stage={view.stage}
    >
      <h3>Where should this change be published?</h3>

      {/* Every staged path, grouped by the thing that owns it. */}
      <ul className="save-destination__changes" data-testid="animation-publication-domains">
        {view.domains.length === 0 && (
          <li className="muted" data-testid="animation-publication-empty">
            Nothing is staged yet. Stage a change in Diff; these are the places it could go.
          </li>
        )}
        {view.domains.map((domain) => (
          <li
            key={`${domain.domain}:${domain.paths[0]}`}
            data-testid={`animation-publication-domain-${domain.domain}`}
            className={domain.blockedReason ? 'finding finding--blocking' : ''}
          >
            <strong>{domain.label}</strong> — <code>{describeOwner(domain.owner)}</code>
            <br />
            <span className="muted small">{domain.paths.length} staged path(s)</span>
            {domain.blockedReason && <p className="small">{domain.blockedReason}</p>}
          </li>
        ))}
      </ul>

      {blocked && (
        <p className="finding finding--blocking" data-testid="animation-publication-blocked">
          {view.blocking.length} staged path(s) have no exact owner. Publication refuses rather than
          guessing a destination. Revert them, or resolve their ownership.
        </p>
      )}

      {view.source && (
        <p data-testid="animation-publication-source">
          Source: <code>{view.source.assetId}@{view.source.version}</code>{' '}
          <span className="muted small">hash {view.source.contentHash.slice(0, 12)}…</span>
        </p>
      )}

      <fieldset className="save-destination__options" data-testid="animation-publication-targets">
        <legend>
          Publish a new version of this asset, and choose which Prefabs adopt it
        </legend>

        {/*
          Publish-only is an explicit choice, not the state you are in before
          choosing. The two are different decisions and are represented
          differently: `choosing` cannot submit at all.
        */}
        <label
          className="save-destination__option"
          data-testid="animation-publication-publish-only"
        >
          <input
            type="radio"
            name="animation-publication-mode"
            checked={view.stage === 'publish-only'}
            onChange={() => controller.choosePublishOnly()}
          />
          <span>
            <strong>Publish only</strong>
            <em className="save-destination__impact">
              A new immutable asset version is created. No Prefab adopts it; every current holder
              stays on the version it names now.
            </em>
          </span>
        </label>

        {view.holders.length === 0 ? (
          <p className="muted small" data-testid="animation-publication-no-holders">
            No Prefab currently holds this asset, so there is nothing to adopt it.
          </p>
        ) : (
          <ul className="save-destination__holders" data-testid="animation-publication-holders">
            {view.holders.map((holder) => {
              const selected = view.selectedPrefabIds.includes(holder.assetId);
              return (
                <li key={`${holder.assetId}@${holder.version}`}>
                  <label data-testid={`animation-publication-holder-${holder.assetId}`}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => controller.togglePublicationTarget(holder.assetId)}
                    />
                    <code>
                      {holder.assetId}@{holder.version}
                    </code>{' '}
                    <span className="muted small">
                      {selected ? 'adopts the new version' : 'stays where it is'}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      {plan && (
        <div className="save-destination__preview" data-testid="animation-publication-preview">
          <p>
            <strong>Selected targets:</strong>{' '}
            <span data-testid="animation-publication-selected">
              {plan.selectedTargets.map((target) => `${target.assetId}@${target.version}`).join(', ') ||
                'none'}
            </span>
          </p>
          <p className="muted">
            <strong>Will not change:</strong>{' '}
            <span data-testid="animation-publication-non-targets">
              {plan.nonTargets.map((target) => `${target.assetId}@${target.version}`).join(', ') ||
                'nothing else holds this asset'}
            </span>
          </p>
          {plan.protectedTargets.length > 0 && (
            <p className="finding finding--blocking" data-testid="animation-publication-protected">
              Protected and cannot adopt:{' '}
              {plan.protectedTargets.map((target) => target.assetId).join(', ')}
            </p>
          )}
          <p className="muted small">
            <strong>Expected writes:</strong>
          </p>
          <ul className="save-destination__writes" data-testid="animation-publication-writes">
            {plan.expectedWrites.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
          {plan.conflicts.length > 0 && (
            <ul className="findings" data-testid="animation-publication-conflicts">
              {plan.conflicts.map((conflict) => (
                <li key={conflict.message} className="finding finding--blocking">
                  <strong>{conflict.code}</strong> · {conflict.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <textarea
        rows={2}
        placeholder="Why is this being published? Recorded with the revision."
        value={intent}
        onChange={(event) => setIntent(event.target.value)}
        data-testid="animation-publication-intent"
      />

      {offline && (
        <p className="muted small" data-testid="animation-publication-offline">
          {OFFLINE_PUBLICATION_MESSAGE}
        </p>
      )}

      <div className="asset-dialog__actions">
        <button
          type="button"
          data-testid="animation-publication-submit"
          disabled={!chosen || blocked || offline || view.stage === 'submitting' || !view.source}
          onClick={() => void controller.submitPublication(intent)}
        >
          {view.stage === 'submitting' ? 'Publishing…' : 'Publish'}
        </button>
        <button
          type="button"
          data-testid="animation-publication-cancel"
          onClick={() => controller.closePublication()}
        >
          Close
        </button>
      </div>

      {view.result && (
        <div
          className={view.result.ok ? 'save-destination__result' : 'findings'}
          data-testid="animation-publication-result"
          data-ok={view.result.ok ? 'true' : 'false'}
        >
          {view.result.ok ? (
            <>
              <p data-testid="animation-publication-published">
                Published{' '}
                <code>
                  {view.result.publishedAnimation?.assetId}@{view.result.publishedAnimation?.version}
                </code>
              </p>
              <ul data-testid="animation-publication-changed">
                {view.result.publishedPrefabs.map((prefab) => (
                  <li key={prefab.assetId}>
                    <code>
                      {prefab.assetId}@{prefab.version}
                    </code>
                  </li>
                ))}
              </ul>
              {/*
                The route does not move on its own. Jumping the session to the
                new version would discard unrelated local edits and change what
                the URL identifies without being asked.
              */}
              <p className="muted small">
                This workspace stays on the version it opened. Open the new Prefab version when you
                are ready.
              </p>
            </>
          ) : (
            <ul>
              {view.result.conflicts.map((conflict) => (
                <li key={conflict.message} className="finding finding--blocking">
                  <strong>{conflict.code}</strong> · {conflict.message}
                </li>
              ))}
              <li className="muted small" data-testid="animation-publication-zero-writes">
                Nothing was written. The repository is exactly as it was.
              </li>
            </ul>
          )}
        </div>
      )}

      {view.log.length > 0 && (
        <ul className="commit-log" data-testid="animation-publication-log">
          {view.log.map((entry, index) => (
            <li key={index}>
              <code>{entry}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
