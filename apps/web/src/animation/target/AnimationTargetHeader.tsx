/**
 * "Whose animation is this?", answered in the header rather than in a dropdown
 * the user has to operate before the workspace does anything.
 *
 * Follow Selection is the default and shows the derived instance. Pin is one
 * button, and a pinned target that has since been deleted says so instead of
 * quietly becoming a different character.
 */
import { useChamber } from '../../store.ts';
import { describeAnimationTargetIssue } from './animation-target.ts';
import { describeAnimationTargetFailure } from './resolve-animation-target.ts';
import { useAnimationTarget } from './useAnimationTarget.ts';

export function AnimationTargetHeader() {
  const mode = useChamber((state) => state.animationTargetMode);
  const setMode = useChamber((state) => state.setAnimationTargetMode);
  const pin = useChamber((state) => state.pinAnimationTarget);
  const world = useChamber((state) => state.stagedWorld);
  const openCharacterDefinition = useChamber((state) => state.openCharacterDefinition);
  // Derived from the current selection and world — there is no stored effective
  // target that could fall out of date with either of them.
  const { resolution, resolved, subject } = useAnimationTarget();

  const displayName =
    resolution.instanceId === null
      ? null
      : (world.instances.find((instance) => instance.id === resolution.instanceId)?.displayName ??
        resolution.instanceId);

  /*
   * Character Lab previews a definition, so Follow Selection and Pin are not
   * offered: there is no scene selection to follow and one legal subject to
   * pin. Showing them disabled would be a control that never does anything.
   */
  if (subject?.kind === 'character-lab') {
    return (
      <div className="animation-target" data-testid="animation-target">
        <span className="animation-target__label">Subject</span>
        <span className="animation-target__value" data-testid="animation-target-instance">
          {subject.characterId}
        </span>
        <span className="animation-target__mode" data-testid="animation-subject-character-lab">
          Character Lab Preview
        </span>
        {resolved?.ok && (
          <div className="animation-target__assets" data-testid="animation-target-assets">
            <span>
              Behavior <b>{resolved.target.behaviorRef.assetId}</b>
            </span>
            <span>
              Motion Set <b>{resolved.target.motionSetRef.assetId}</b>
            </span>
            <span>
              Context <b>{resolved.target.effectiveWeaponModeId}</b>
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="animation-target" data-testid="animation-target">
      <span className="animation-target__label">Target</span>
      <span className="animation-target__value" data-testid="animation-target-instance">
        {resolution.instanceId ?? '—'}
      </span>
      {displayName && displayName !== resolution.instanceId && (
        <span className="animation-target__name">{displayName}</span>
      )}

      {mode.kind === 'pinned' ? (
        <>
          <span className="animation-target__mode is-pinned" data-testid="animation-target-pinned">
            Pinned
          </span>
          <button
            type="button"
            data-testid="animation-target-follow"
            onClick={() => setMode({ kind: 'follow-selection' })}
          >
            Follow Selection
          </button>
        </>
      ) : (
        <>
          <span className="animation-target__mode" data-testid="animation-target-mode">
            Follow Selection
          </span>
          <button
            type="button"
            data-testid="animation-target-pin"
            disabled={resolution.instanceId === null}
            title="Keep this target while the scene selection moves elsewhere."
            onClick={() => pin()}
          >
            Pin
          </button>
        </>
      )}

      {resolution.issue && (
        <p className="animation-target__issue" data-testid="animation-target-issue">
          {describeAnimationTargetIssue(resolution.issue)}
        </p>
      )}
      {resolved && !resolved.ok && (
        <p className="animation-target__issue" data-testid="animation-target-failure">
          {describeAnimationTargetFailure(resolved.failure)}
        </p>
      )}

      {resolved?.ok && (
        <div className="animation-target__assets" data-testid="animation-target-assets">
          <span>
            Character <b>{resolved.target.characterId}</b>
          </span>
          <span>
            Behavior <b>{resolved.target.behaviorRef.assetId}</b>
          </span>
          <span>
            Motion Set <b>{resolved.target.motionSetRef.assetId}</b>
          </span>
          <span>
            Context <b>{resolved.target.effectiveWeaponModeId}</b>
          </span>
          {/* Assignment is Project/Assets' job — this is a link to it, not a
              second place to change which assets a character uses. */}
          <button
            type="button"
            data-testid="animation-open-character"
            onClick={() => openCharacterDefinition(resolved.target.characterId)}
          >
            Open Character Definition
          </button>
        </div>
      )}
    </div>
  );
}
