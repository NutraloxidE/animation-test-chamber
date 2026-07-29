import { useState } from 'react';
import { useChamber } from '../store.ts';

const EXAMPLES = [
  '攻撃の初動を速くし、重量感は残す',
  'make the dodge cancel feel sharper without losing the recovery',
  '着地からの走り出しをもっと滑らかに',
];

/**
 * AI Command Panel (PLAN 14). Proposals are never applied silently: each one
 * lists what it would change, what it refused to touch, and what it costs.
 */
export function AiPanel() {
  const proposals = useChamber((state) => state.proposals);
  const aiBusy = useChamber((state) => state.aiBusy);
  const aiMessage = useChamber((state) => state.aiMessage);
  const requestProposals = useChamber((state) => state.requestProposals);
  const applyProposal = useChamber((state) => state.applyProposal);
  const selectedTransitionId = useChamber((state) => state.selectedTransitionId);

  const [request, setRequest] = useState(EXAMPLES[0]!);

  return (
    <div className="panel" data-testid="ai-panel">
      <header className="panel__header">
        <h2>AI Tuning</h2>
        <span className="muted">target: {selectedTransitionId}</span>
      </header>

      <textarea
        rows={3}
        value={request}
        onChange={(event) => setRequest(event.target.value)}
        placeholder="Describe how it should feel, in any language."
      />

      <div className="button-row">
        <button
          type="button"
          disabled={aiBusy}
          onClick={() => requestProposals(request)}
          data-testid="request-proposals"
        >
          {aiBusy ? 'Thinking…' : 'Propose A / B / C'}
        </button>
      </div>

      <div className="examples">
        {EXAMPLES.map((example) => (
          <button type="button" key={example} className="chip" onClick={() => setRequest(example)}>
            {example}
          </button>
        ))}
      </div>

      {aiMessage && <p className="muted">{aiMessage}</p>}

      {proposals.map((proposal) => (
        <article className="proposal" key={proposal.variant}>
          <h3>
            {proposal.title}
            {proposal.requiresApproval && <span className="badge badge--approval">approval</span>}
          </h3>
          <p>{proposal.rationale}</p>

          {proposal.changes.length === 0 ? (
            <p className="muted">No change proposed for this variant.</p>
          ) : (
            <ul className="change-list">
              {proposal.changes.map((change) => (
                <li key={change.path}>
                  <code>{change.path.split('/').pop()}</code>{' '}
                  <span className="muted">
                    {String(change.before)} → {String(change.after)}
                  </span>
                  <br />
                  <span className="small muted">{change.reason}</span>
                </li>
              ))}
            </ul>
          )}

          {proposal.protectedFieldsRespected.length > 0 && (
            <p className="protected-note">
              Left untouched (protected):{' '}
              {proposal.protectedFieldsRespected.map((path) => path.split('/').pop()).join(', ')}
            </p>
          )}

          {proposal.expectedTradeoffs.length > 0 && (
            <details>
              <summary>Trade-offs</summary>
              <ul>
                {proposal.expectedTradeoffs.map((tradeoff, index) => (
                  <li key={index}>{tradeoff}</li>
                ))}
              </ul>
            </details>
          )}

          {proposal.testImpact.length > 0 && (
            <p className="small muted">Replays likely affected: {proposal.testImpact.join(', ')}</p>
          )}

          <div className="button-row">
            <button type="button" onClick={() => applyProposal(proposal, false)}>
              Apply as preview
            </button>
            {proposal.requiresApproval && (
              <button
                type="button"
                className="primary"
                onClick={() => applyProposal(proposal, true)}
              >
                Approve &amp; apply
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
