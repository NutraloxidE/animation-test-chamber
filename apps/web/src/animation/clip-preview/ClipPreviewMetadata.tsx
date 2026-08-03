/**
 * The chain from state to pixels, written out.
 *
 * A preview that shows a pose and nothing else leaves "why is this the clip I
 * am seeing?" unanswerable — and under contextual bindings the answer genuinely
 * depends on the target's weapon and equipment, not on anything visible in the
 * state name.
 */
import type { ResolvedAnimationTarget } from '../target/resolve-animation-target.ts';
import { resolveStateClip } from '../target/resolve-animation-target.ts';
import type { ClipPreviewSource } from './clip-preview-state.ts';

export function ClipPreviewMetadata({
  target,
  source,
  durationSec,
}: {
  target: ResolvedAnimationTarget;
  source: ClipPreviewSource;
  durationSec: number;
}) {
  const equipped = Object.entries(target.effectiveEquipment)
    .filter(([, on]) => on)
    .map(([slot]) => slot);
  const context = [target.effectiveWeaponModeId, ...equipped].join(' / ');

  if (source.kind === 'clip') {
    return (
      <dl className="clip-preview__metadata" data-testid="clip-preview-metadata">
        <div>
          <dt>Clip</dt>
          <dd data-testid="clip-preview-clip">{source.clipId}</dd>
        </div>
        <div>
          <dt>Context</dt>
          <dd>{context}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd data-testid="clip-preview-duration">{durationSec.toFixed(2)} s</dd>
        </div>
      </dl>
    );
  }

  const resolved = resolveStateClip(target, source.stateId);
  return (
    <dl className="clip-preview__metadata" data-testid="clip-preview-metadata">
      <div>
        <dt>State</dt>
        <dd data-testid="clip-preview-state-id">{source.stateId}</dd>
      </div>
      <div>
        <dt>Slot</dt>
        <dd data-testid="clip-preview-slot">{resolved?.motionSlot ?? '—'}</dd>
      </div>
      <div>
        <dt>Resolved clip</dt>
        {/* An unbound slot says so rather than showing a blank cell: "this
            state has no clip in this context" is the answer, and it is the one
            a silent empty pose used to hide. */}
        <dd data-testid="clip-preview-clip">{resolved?.clipId ?? 'unbound in this context'}</dd>
      </div>
      <div>
        <dt>Context</dt>
        <dd data-testid="clip-preview-context">{context}</dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd data-testid="clip-preview-duration">{durationSec.toFixed(2)} s</dd>
      </div>
    </dl>
  );
}
