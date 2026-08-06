import { useChamber } from './chamber-source.ts';

interface FieldProps {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Optional unit conversion for display, e.g. seconds -> frames. */
  format?: (value: number) => string;
  /**
   * Overrides the default test id. A path can legitimately appear twice on
   * screen — once in the detail view, once in a list — and two elements sharing
   * a test id make every locator for it ambiguous.
   */
  testId?: string;
}

const ORIGIN_LABEL: Record<string, string> = {
  repository: 'repository',
  'ai-proposal': 'AI proposal',
  'human-preview': 'human preview',
  'human-final': 'human final (staged)',
};

/**
 * One tunable value. Shows where the current number came from, whether
 * protection allows editing it, and offers the reset paths from PLAN 9.2.
 */
export function Field({ path, label, min, max, step, format, testId }: FieldProps) {
  const session = useChamber((state) => state.session);
  // Subscribing to `revision` is what makes the control re-read the session
  // after any edit, undo or commit.
  useChamber((state) => state.revision);

  const setPreviewValue = useChamber((state) => state.setPreviewValue);
  const resetToRepository = useChamber((state) => state.resetToRepository);
  const resetToAiProposal = useChamber((state) => state.resetToAiProposal);
  const stage = useChamber((state) => state.stage);
  const unlockPath = useChamber((state) => state.unlockPath);

  const view = session.fieldView(path);
  const value = typeof view.previewValue === 'number' ? view.previewValue : min;
  const changed = !Object.is(view.previewValue, view.repositoryValue);
  const locked = !view.editableByHuman;

  return (
    <div className={`field${locked ? ' field--locked' : ''}`} data-testid={testId ?? `field-${path}`}>
      <div className="field__head">
        <label className="field__label" htmlFor={path}>
          {label}
          {locked && (
            <span className="badge badge--locked" title={view.protectionReason}>
              locked
            </span>
          )}
          {!locked && !view.editableByAi && (
            <span className="badge badge--approval" title={view.protectionReason}>
              approval
            </span>
          )}
        </label>
        <output className="field__value">{format ? format(value) : value.toFixed(3)}</output>
      </div>

      <input
        id={path}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={locked}
        onChange={(event) => setPreviewValue(path, Number(event.target.value))}
      />

      <div className="field__foot">
        <span className={`origin origin--${view.origin}`}>{ORIGIN_LABEL[view.origin]}</span>
        {(changed || view.needsSave) && (
          <>
            <button type="button" onClick={() => resetToRepository(path)}>
              reset
            </button>
            {view.aiProposalValue !== undefined && (
              <button type="button" onClick={() => resetToAiProposal(path)}>
                to AI
              </button>
            )}
            <button
              type="button"
              className={view.staged ? 'is-staged' : view.needsSave ? 'needs-save' : ''}
              onClick={() => stage(path)}
            >
              {view.staged ? '✓ staged' : view.needsSave ? 'save changes' : 'stage'}
            </button>
            {view.needsSave && (
              <span className="save-warning" role="status">
                changed since staged
              </span>
            )}
          </>
        )}
        {locked && (
          <button type="button" className="danger" onClick={() => unlockPath(path)}>
            unlock for session
          </button>
        )}
      </div>

      {locked && <p className="field__reason">{view.protectionReason}</p>}
    </div>
  );
}

interface ToggleProps {
  path: string;
  label: string;
}

export function ToggleField({ path, label }: ToggleProps) {
  const session = useChamber((state) => state.session);
  useChamber((state) => state.revision);
  const setPreviewValue = useChamber((state) => state.setPreviewValue);

  const view = session.fieldView(path);
  const value = view.previewValue === true;

  return (
    <div className="field field--toggle">
      <label>
        <input
          type="checkbox"
          checked={value}
          disabled={!view.editableByHuman}
          onChange={(event) => setPreviewValue(path, event.target.checked)}
        />
        {label}
      </label>
      <span className={`origin origin--${view.origin}`}>{ORIGIN_LABEL[view.origin]}</span>
    </div>
  );
}
