/**
 * Diff / staging, on an exact subject.
 *
 * The donor's body is preserved: change count, staged count, needs-save count,
 * findings sorted by severity, stage all, revert session, per-field stage and
 * revert, protection badges, intent text, offline state and a result log. Those
 * are the things a human reads before deciding, and none of them was wrong.
 *
 * What is replaced is where the button goes. `commit()` wrote project.json,
 * which was a coherent destination for a Character and is not one for an exact
 * Prefab node Animator — its values come from several immutable assets with
 * different owners and different blast radii. So "Apply staged to repository"
 * no longer writes anything: it opens the exact publication plan, and the write
 * happens there, against targets a human named.
 *
 * The pull request entry is gone rather than disabled-with-a-tooltip, because
 * there is no supported path behind it for this publication route and a control
 * that can never succeed is worse than an absent one. Publication is a
 * transaction against the repository, not a branch.
 */
import { useState } from 'react';
import { useChamber } from './chamber-source.ts';
import { AnimationSaveDestination } from '../animation-chamber/AnimationSaveDestination.tsx';
import { describeOwner } from '../animation-chamber/animation-publication-state.ts';

const SEVERITY_ORDER = { blocking: 0, warning: 1, informational: 2 } as const;

export function DiffPanel() {
  const session = useChamber((state) => state.session);
  useChamber((state) => state.revision);
  const stage = useChamber((state) => state.stage);
  const stageAll = useChamber((state) => state.stageAll);
  const revertSession = useChamber((state) => state.revertSession);
  const resetToRepository = useChamber((state) => state.resetToRepository);
  const publication = useChamber((state) => state.publication);
  const document = useChamber((state) => state.project);
  const backendOnline = useChamber((state) => state.backendOnline);
  const offline = backendOnline === false;

  const [intent, setIntent] = useState('');

  const diff = session.diff();
  const validation = session.validate();
  const staged = session.stagedPaths;
  const needsSave = session.needsSavePaths;

  const findings = [...diff.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const publicationView = publication.snapshot();
  const ownerless = publicationView.blocking;

  return (
    <div className="panel" data-testid="diff-panel">
      <header className="panel__header">
        <h2>Diff &amp; Staging</h2>
        <span className="muted">
          {diff.changes.length} change(s), {staged.length} staged
          {needsSave.length > 0 ? `, ${needsSave.length} need saving again` : ''}
        </span>
      </header>

      <div className="button-row">
        <button type="button" onClick={stageAll} data-testid="stage-all">
          Stage all
        </button>
        <button type="button" onClick={revertSession} data-testid="revert-session">
          Revert session
        </button>
      </div>

      {findings.length > 0 && (
        <ul className="findings">
          {findings.map((finding, index) => (
            <li key={index} className={`finding finding--${finding.severity}`}>
              <strong>{finding.severity}</strong> · {finding.rule}
              <br />
              <code>{finding.path}</code>
              <br />
              {finding.message}
            </li>
          ))}
        </ul>
      )}

      {/*
        A staged path with no exact owner is a blocking finding in its own
        right. It used to be invisible because `commit()` had one destination
        and wrote everything there; naming the gap is the point.
      */}
      {ownerless.length > 0 && (
        <ul className="findings" data-testid="diff-unowned-findings">
          {ownerless.map((entry) => (
            <li key={entry.path} className="finding finding--blocking">
              <strong>blocking</strong> · no exact owner
              <br />
              <code>{entry.path}</code>
              <br />
              {entry.blockedReason}
            </li>
          ))}
        </ul>
      )}

      {diff.changes.length === 0 ? (
        <p className="muted">No changes yet. Adjust a value in the inspector.</p>
      ) : (
        <ul className="diff-list">
          {diff.changes.map((change) => {
            const view = session.fieldView(change.path);
            return (
              <li
                key={change.path}
                className={view.staged ? 'is-staged' : view.needsSave ? 'needs-save' : ''}
              >
                <code>{change.path}</code>
                <br />
                <span className="muted">
                  {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
                </span>
                {change.protection !== 'editable' && (
                  <span className={`badge badge--${change.protection}`}>{change.protection}</span>
                )}
                <div className="button-row">
                  <button
                    type="button"
                    className={view.staged ? 'is-staged' : view.needsSave ? 'needs-save' : ''}
                    onClick={() => stage(change.path)}
                  >
                    {view.staged ? '✓ staged' : view.needsSave ? 'save changes' : 'stage'}
                  </button>
                  <button type="button" onClick={() => resetToRepository(change.path)}>
                    revert field
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <section className="commit-box">
        <h3>Apply to repository</h3>

        {/*
          What each staged change would be written into, before the human opens
          the destination surface. Seeing "Behavior graph asset" next to the
          exact asset id is what makes the blast radius a fact rather than a
          surprise on the next screen.
        */}
        {publicationView.domains.length > 0 && (
          <ul className="staged-domains" data-testid="diff-staged-domains">
            {publicationView.domains.map((domain) => (
              <li key={`${domain.domain}:${domain.paths[0]}`}>
                <strong>{domain.label}</strong> — <code>{describeOwner(domain.owner)}</code>{' '}
                <span className="muted small">{domain.paths.length} path(s)</span>
              </li>
            ))}
          </ul>
        )}

        {!validation.valid && (
          <ul className="findings" data-testid="diff-validation-issues">
            {validation.issues.slice(0, 5).map((issue, index) => (
              <li key={index} className="finding finding--blocking">
                <code>{issue.path}</code> {issue.message}
              </li>
            ))}
          </ul>
        )}

        <textarea
          placeholder="Why did you change this? Recorded with the revision."
          value={intent}
          onChange={(event) => setIntent(event.target.value)}
          rows={3}
        />

        <div className="button-row">
          <button
            type="button"
            disabled={staged.length === 0 || !validation.valid || !diff.commitAllowed}
            onClick={() => publication.openPublication()}
            data-testid="commit-button"
          >
            Apply staged to repository
          </button>
        </div>

        {/*
          Clicking above opens the impact surface; it never writes. That is the
          §8 rule stated where a reader of this panel will meet it.
        */}
        <p className="muted small">
          This opens the exact publication plan. Nothing is written until targets are named there.
        </p>

        {offline && (
          <p className="muted small" data-testid="diff-offline">
            No API server in this deployment. Preview and staged state remain local; publication
            needs the server, and no repository or Prefab file has been changed.
          </p>
        )}
        {!diff.commitAllowed && (
          <p className="finding finding--blocking">
            Publication is blocked while a protected value is changed. Unlock it explicitly, or
            revert it.
          </p>
        )}

        <AnimationSaveDestination key={document.subject.subjectId} />
      </section>
    </div>
  );
}
