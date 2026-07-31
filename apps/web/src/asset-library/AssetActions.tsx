/**
 * Asset actions (PLAN 26).
 *
 * Anything that writes is disabled with its reason on a static host rather than
 * left enabled to fail as a network error (PLAN 37) — a disabled button that
 * explains itself teaches; a fetch that times out does not.
 */
import type { AssetReference } from '@atc/schema';
import { checkDeletePolicy } from '@atc/animation-asset-runtime';
import { useChamber } from '../store.ts';

const STATIC_REASON =
  'Static deployment: there is no API server to write assets. Browsing, preview, drafts and replay comparison all still work.';

export function AssetActions({ reference }: { reference: AssetReference }) {
  const registry = useChamber((state) => state.registry);
  const project = useChamber((state) => state.canonicalProject);
  const backendOnline = useChamber((state) => state.backendOnline);
  const openDialog = useChamber((state) => state.openLibraryDialog);
  const setStatus = useChamber((state) => state.setStatus);
  const setWorkspaceMode = useChamber((state) => state.setWorkspaceMode);

  const writable = backendOnline !== false;
  const deletePolicy = checkDeletePolicy(registry, reference, [project]);
  const isBehavior = reference.assetType === 'animation-behavior';

  return (
    <div className="asset-actions" data-testid="asset-actions">
      <button
        type="button"
        data-testid="asset-action-preview"
        onClick={() => {
          setWorkspaceMode('chamber');
          setStatus(`Previewing ${reference.assetId} in the Chamber.`);
        }}
      >
        Preview in Chamber
      </button>

      <button
        type="button"
        data-testid="asset-action-apply"
        onClick={() => openDialog('apply')}
      >
        Apply to Character
      </button>

      <button
        type="button"
        data-testid="asset-action-derive"
        disabled={!isBehavior}
        title={
          isBehavior
            ? 'Create a variant, fork or duplicate'
            : 'Variants and forks are a behaviour concept; other asset types publish new versions instead.'
        }
        onClick={() => openDialog('derive')}
      >
        Create Variant / Fork / Duplicate
      </button>

      <button
        type="button"
        data-testid="asset-action-save-destination"
        onClick={() => openDialog('save-destination')}
      >
        Save chamber edits…
      </button>

      <button
        type="button"
        data-testid="asset-action-publish"
        disabled={!writable}
        title={writable ? 'Publish a new version' : STATIC_REASON}
        onClick={() =>
          setStatus(
            `Publishing writes a new version of ${reference.assetId}; v${reference.version} is never rewritten.`,
          )
        }
      >
        Publish new version
      </button>

      <button
        type="button"
        data-testid="asset-action-delete"
        disabled={!writable || !deletePolicy.allowed}
        title={
          !writable
            ? STATIC_REASON
            : deletePolicy.allowed
              ? 'Delete this asset version'
              : `Cannot delete: ${deletePolicy.reasons.join('; ')}`
        }
        onClick={() => setStatus(`Delete refused: ${deletePolicy.reasons.join('; ')}`)}
      >
        Delete
      </button>

      {!deletePolicy.allowed && (
        <ul className="asset-actions__blockers" data-testid="asset-delete-blockers">
          {deletePolicy.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}

      {!writable && (
        <p className="muted asset-actions__static" data-testid="asset-actions-static">
          {STATIC_REASON}
        </p>
      )}
    </div>
  );
}
