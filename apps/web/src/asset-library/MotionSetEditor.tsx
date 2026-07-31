/**
 * Motion slot mapping table (PLAN 25.2).
 *
 * This is the screen where a new character stops being work: the behaviour
 * already lists what it needs, and filling this table in is the whole job.
 * A missing required slot is shown as `missing` here rather than discovered as
 * a blank viewport at tick 400.
 */
import { useState } from 'react';
import type { AnimationMotionSetAsset, AssetReference } from '@atc/schema';
import { retargetStatusBetween } from '@atc/animation-asset-runtime';
import { useChamber } from '../store.ts';

export function MotionSetEditor({ reference }: { reference: AssetReference }) {
  const registry = useChamber((state) => state.registry);
  const project = useChamber((state) => state.project);
  const backendOnline = useChamber((state) => state.backendOnline);
  const setStatus = useChamber((state) => state.setStatus);
  const [contextKey, setContextKey] = useState<string>('');

  const motionSet = registry.get(reference) as AnimationMotionSetAsset;
  const behaviorReference = project.character.animation.behavior;
  const behavior = registry.has(behaviorReference)
    ? registry.getBehavior(behaviorReference)
    : null;

  const contextKeys = [
    ...new Set(
      motionSet.bindings
        .map((binding) => binding.contextualKey)
        .filter((key): key is string => key !== undefined),
    ),
  ].sort();

  // Clip candidates are narrowed by rig compatibility, so the picker cannot
  // offer something that would refuse to play once chosen.
  const setRig = registry.has(motionSet.rig) ? registry.getRig(motionSet.rig) : null;
  const clipOptions = registry
    .all()
    .filter((stored) => stored.assetType === 'animation-clip')
    .filter((stored) => {
      if (!setRig) return true;
      const clip = stored.document as { compatibleRigIds: string[] };
      if (clip.compatibleRigIds.length === 0) return true;
      return clip.compatibleRigIds.some((rigId) => {
        const versions = registry.versionsOf('humanoid-rig', rigId);
        const latest = versions.at(-1);
        if (!latest) return false;
        const rig = registry.getRig(registry.referenceTo('humanoid-rig', rigId, latest));
        return retargetStatusBetween(rig, setRig) !== 'conversion-required';
      });
    });

  const bindingFor = (slotId: string): AssetReference | undefined => {
    const contextual = contextKey
      ? motionSet.bindings.find(
          (binding) => binding.motionSlot === slotId && binding.contextualKey === contextKey,
        )
      : undefined;
    const base = motionSet.bindings.find(
      (binding) => binding.motionSlot === slotId && binding.contextualKey === undefined,
    );
    return (contextual ?? base)?.clip;
  };

  const rows = (behavior?.motionSlots ?? []).map((slot) => ({
    slot,
    clip: bindingFor(slot.id),
  }));

  return (
    <section className="motion-set-editor" data-testid="motion-set-editor">
      <h4>Motion slot mapping</h4>

      {contextKeys.length > 0 && (
        <label className="motion-set-editor__context">
          Context
          <select
            value={contextKey}
            onChange={(event) => setContextKey(event.target.value)}
            data-testid="motion-set-context"
          >
            <option value="">default</option>
            {contextKeys.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
        </label>
      )}

      {behavior === null ? (
        <p className="muted">
          The active character’s behaviour could not be resolved, so there is no slot contract to
          map against.
        </p>
      ) : (
        <table className="asset-table" data-testid="motion-set-table">
          <thead>
            <tr>
              <th>Slot</th>
              <th>Required</th>
              <th>Assigned clip</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ slot, clip }) => {
              const status = clip ? 'valid' : slot.required ? 'missing' : 'unbound';
              return (
                <tr key={slot.id} data-testid={`motion-slot-${slot.id}`} data-status={status}>
                  <td>
                    <code>{slot.id}</code>
                  </td>
                  <td>{slot.required ? 'yes' : 'no'}</td>
                  <td>
                    <select
                      value={clip?.assetId ?? ''}
                      disabled={backendOnline === false}
                      data-testid={`motion-slot-select-${slot.id}`}
                      title={
                        backendOnline === false
                          ? 'Rebinding writes a new motion set version, which needs the local API server.'
                          : 'Bind a clip to this slot'
                      }
                      onChange={(event) =>
                        setStatus(
                          `Binding ${slot.id} to ${event.target.value} publishes a new version of ` +
                            `"${motionSet.metadata.id}". Use Publish to confirm.`,
                        )
                      }
                    >
                      <option value="">— none —</option>
                      {clipOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.id}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={`asset-badge asset-badge--${status === 'valid' ? 'valid' : 'invalid'}`}>
                      {status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
