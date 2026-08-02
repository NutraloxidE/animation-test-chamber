/**
 * Version comparison (PLAN 26 "Compare Versions").
 *
 * Also answers "what did my fork actually change", which is the question a
 * detached fork would otherwise make unanswerable — the link is severed for
 * resolution, but the provenance is kept precisely so this view can exist.
 */
import { useState } from 'react';
import type { AnimationBehaviorAsset, AssetReference } from '@atc/schema';
import { diffToPatches } from '@atc/animation-asset-runtime';
import { useChamber } from '../store.ts';

export function VersionDiff({ reference }: { reference: AssetReference }) {
  const registry = useChamber((state) => state.registry);
  const versions = registry.versionsOf(reference.assetType, reference.assetId);
  const asset = registry.get(reference);
  const origin =
    (asset as AnimationBehaviorAsset).derivation?.mode === 'fork'
      ? ((asset as AnimationBehaviorAsset).derivation as { forkedFrom: AssetReference }).forkedFrom
      : asset.metadata.assetProvenance?.duplicatedFrom;

  const comparable = [
    ...versions
      .filter((version) => version !== reference.version)
      .map((version) => ({
        label: `v${version}`,
        reference: { ...reference, version, contentHash: '' },
      })),
    ...(origin && registry.has(origin)
      ? [{ label: `origin ${origin.assetId} v${origin.version}`, reference: origin }]
      : []),
  ];

  const [against, setAgainst] = useState<string>('');
  const selected = comparable.find((entry) => entry.label === against);
  const patches = selected
    ? diffToPatches(registry.get(selected.reference), asset, '')
    : [];

  if (comparable.length === 0) {
    return (
      <section data-testid="version-diff-none">
        <h4>Compare versions</h4>
        <p className="muted">This is the only version, and it has no recorded origin.</p>
      </section>
    );
  }

  return (
    <section data-testid="version-diff">
      <h4>Compare versions</h4>
      <label>
        Against
        <select
          value={against}
          onChange={(event) => setAgainst(event.target.value)}
          data-testid="version-diff-select"
        >
          <option value="">— pick a version —</option>
          {comparable.map((entry) => (
            <option key={entry.label} value={entry.label}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <>
          <p className="muted" data-testid="version-diff-count">
            {patches.length} difference{patches.length === 1 ? '' : 's'}
          </p>
          <ul className="version-diff__list">
            {patches.slice(0, 40).map((patch, index) => (
              <li key={`${patch.path}-${index}`}>
                <code>{patch.op}</code> <code>{patch.path}</code>
                {patch.op !== 'remove' && <> → {JSON.stringify(patch.value)?.slice(0, 80)}</>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
