/**
 * One Animation workspace, two explicit modes.
 *
 * These used to be one panel whose name promised runtime behaviour and whose
 * implementation delivered a pose substitution. Both are worth having; neither
 * is the other. The mode tabs are the smallest structure that lets each one's
 * banner be literally true, and they share the target header because "whose
 * animation is this?" has the same answer in both.
 */
import { useChamber } from '../store.ts';
import { ClipPreviewWorkspace } from '../animation/clip-preview/ClipPreviewWorkspace.tsx';
import { StateSandboxWorkspace } from '../animation/state-sandbox/StateSandboxWorkspace.tsx';

export function AnimationWorkspace() {
  const mode = useChamber((state) => state.animationWorkspaceMode);
  const setMode = useChamber((state) => state.setAnimationWorkspaceMode);

  return (
    <div className="workspace workspace--animation" data-testid="animation-workspace">
      <nav className="workspace__modes" data-testid="animation-modes">
        <button
          type="button"
          className={mode === 'clip-preview' ? 'is-active' : ''}
          data-testid="animation-mode-clip-preview"
          onClick={() => setMode('clip-preview')}
        >
          Clip Preview
        </button>
        <button
          type="button"
          className={mode === 'state-sandbox' ? 'is-active' : ''}
          data-testid="animation-mode-state-sandbox"
          onClick={() => setMode('state-sandbox')}
        >
          State Sandbox
        </button>
      </nav>
      {mode === 'clip-preview' ? <ClipPreviewWorkspace /> : <StateSandboxWorkspace />}
    </div>
  );
}
