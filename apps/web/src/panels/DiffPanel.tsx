import { useState } from 'react';
import { useChamber } from '../store.ts';

const SEVERITY_ORDER = { blocking: 0, warning: 1, informational: 2 } as const;

/**
 * Diff / staging panel (PLAN 9). This is the gate between "I changed something
 * in the browser" and "it is in the repository": the classified findings here
 * are the same ones the API re-derives server-side before committing.
 */
export function DiffPanel() {
  const session = useChamber((state) => state.session);
  useChamber((state) => state.revision);
  const stage = useChamber((state) => state.stage);
  const stageAll = useChamber((state) => state.stageAll);
  const revertSession = useChamber((state) => state.revertSession);
  const resetToRepository = useChamber((state) => state.resetToRepository);
  const commit = useChamber((state) => state.commit);
  const createPullRequest = useChamber((state) => state.createPullRequest);
  const commitLog = useChamber((state) => state.commitLog);
  const backendOnline = useChamber((state) => state.backendOnline);
  const offline = backendOnline === false;

  const [intent, setIntent] = useState('');

  const diff = session.diff();
  const validation = session.validate();
  const staged = session.stagedPaths;

  const findings = [...diff.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return (
    <div className="panel" data-testid="diff-panel">
      <header className="panel__header">
        <h2>Diff &amp; Staging</h2>
        <span className="muted">
          {diff.changes.length} change(s), {staged.length} staged
        </span>
      </header>

      <div className="button-row">
        <button type="button" onClick={stageAll} data-testid="stage-all">
          Stage all
        </button>
        <button type="button" onClick={revertSession}>
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

      {diff.changes.length === 0 ? (
        <p className="muted">No changes yet. Adjust a value in the inspector.</p>
      ) : (
        <ul className="diff-list">
          {diff.changes.map((change) => (
            <li key={change.path} className={session.stagedPaths.includes(change.path) ? 'is-staged' : ''}>
              <code>{change.path}</code>
              <br />
              <span className="muted">
                {JSON.stringify(change.before)} → {JSON.stringify(change.after)}
              </span>
              {change.protection !== 'editable' && (
                <span className={`badge badge--${change.protection}`}>{change.protection}</span>
              )}
              <div className="button-row">
                <button type="button" onClick={() => stage(change.path)}>
                  stage
                </button>
                <button type="button" onClick={() => resetToRepository(change.path)}>
                  revert field
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="commit-box">
        <h3>Apply to repository</h3>
        {!validation.valid && (
          <ul className="findings">
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
            disabled={offline || staged.length === 0 || !validation.valid || !diff.commitAllowed}
            onClick={() => commit(intent)}
            data-testid="commit-button"
          >
            Apply staged to repository
          </button>
          <button type="button" onClick={createPullRequest} disabled={offline}>
            Create pull request
          </button>
        </div>
        {offline && (
          <p className="muted small">
            No API server in this deployment, so nothing can be written to the repository. Staged
            changes are kept in this browser and survive a reload.
          </p>
        )}
        {!diff.commitAllowed && (
          <p className="finding finding--blocking">
            Commit is blocked while a protected value is changed. Unlock it explicitly, or revert it.
          </p>
        )}

        {commitLog.length > 0 && (
          <ul className="commit-log">
            {commitLog.map((entry, index) => (
              <li key={index}>
                <code>{entry}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
