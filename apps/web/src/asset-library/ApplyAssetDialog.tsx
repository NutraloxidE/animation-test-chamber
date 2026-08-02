/**
 * Apply to Character (PLAN 27) and the derive dialog (PLAN 26).
 *
 * Applying shows compatibility, missing slots and the overrides it would
 * disturb *before* anything is written, and the write itself goes through the
 * atomic transaction endpoint — so a refusal leaves the project exactly as it
 * was rather than half-applied.
 */
import { useState } from 'react';
import type { AssetReference, CharacterAnimationAssignment } from '@atc/schema';
import { checkMotionSetCompatibility, resolveBehaviorAsset } from '@atc/animation-asset-runtime';
import { useChamber } from '../store.ts';

function pickerOptions(
  registry: ReturnType<typeof useChamber.getState>['registry'],
  assetType: AssetReference['assetType'],
): { id: string; version: string }[] {
  return registry
    .all()
    .filter((stored) => stored.assetType === assetType)
    .map((stored) => ({ id: stored.id, version: stored.version }));
}

export function ApplyAssetDialog() {
  const registry = useChamber((state) => state.registry);
  const canonical = useChamber((state) => state.canonicalProject);
  const project = useChamber((state) => state.project);
  const apply = useChamber((state) => state.applyAssetsToCharacter);
  const close = useChamber((state) => state.openLibraryDialog);
  const backendOnline = useChamber((state) => state.backendOnline);

  const [characterId, setCharacterId] = useState(project.character.id);
  const character =
    canonical.characters.find((entry) => entry.id === characterId) ?? canonical.characters[0]!;

  const [behaviorId, setBehaviorId] = useState(character.animation.behavior.assetId);
  const [motionSetId, setMotionSetId] = useState(character.animation.motionSet.assetId);
  const [rigId, setRigId] = useState(character.animation.rig.assetId);
  const [tuningId, setTuningId] = useState(character.animation.tuning?.assetId ?? '');

  const referenceFor = (
    assetType: AssetReference['assetType'],
    assetId: string,
  ): AssetReference | null => {
    const latest = registry.latestVersion(assetType, assetId);
    return latest ? registry.referenceTo(assetType, assetId, latest) : null;
  };

  const behavior = referenceFor('animation-behavior', behaviorId);
  const motionSet = referenceFor('animation-motion-set', motionSetId);
  const rig = referenceFor('humanoid-rig', rigId);
  const tuning = tuningId ? referenceFor('animation-tuning', tuningId) : null;

  const compatibility =
    behavior && motionSet && rig
      ? checkMotionSetCompatibility(
          registry,
          resolveBehaviorAsset(registry, behavior).asset,
          registry.getMotionSet(motionSet),
          rig,
        )
      : null;

  const affectedOverrides = character.animation.instanceOverrides.length;
  const replayFixtures = behavior ? resolveBehaviorAsset(registry, behavior).asset.replayFixtureIds : [];

  const submit = (): void => {
    if (!behavior || !motionSet || !rig) return;
    const assignment: CharacterAnimationAssignment = {
      behavior,
      motionSet,
      rig,
      ...(tuning ? { tuning } : {}),
      instanceOverrides: character.animation.instanceOverrides,
    };
    void apply(characterId, assignment);
  };

  return (
    <div className="asset-dialog" role="dialog" aria-label="Apply assets to character" data-testid="apply-asset-dialog">
      <h3>Apply to character</h3>

      <label>
        Target character
        <select
          value={characterId}
          onChange={(event) => setCharacterId(event.target.value)}
          data-testid="apply-character"
        >
          {canonical.characters.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.displayName}
            </option>
          ))}
        </select>
      </label>

      {(
        [
          ['Behavior', 'animation-behavior', behaviorId, setBehaviorId, 'behavior'],
          ['Motion set', 'animation-motion-set', motionSetId, setMotionSetId, 'motion-set'],
          ['Rig profile', 'humanoid-rig', rigId, setRigId, 'rig'],
        ] as const
      ).map(([label, assetType, value, setValue, testId]) => (
        <label key={assetType}>
          {label}
          <select
            value={value}
            onChange={(event) => setValue(event.target.value)}
            data-testid={`apply-${testId}`}
          >
            {[...new Set(pickerOptions(registry, assetType).map((option) => option.id))].map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      ))}

      <label>
        Tuning profile
        <select
          value={tuningId}
          onChange={(event) => setTuningId(event.target.value)}
          data-testid="apply-tuning"
        >
          <option value="">— none —</option>
          {[...new Set(pickerOptions(registry, 'animation-tuning').map((option) => option.id))].map(
            (id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ),
          )}
        </select>
      </label>

      <section className="asset-dialog__impact" data-testid="apply-compatibility">
        <h4>Compatibility</h4>
        {compatibility === null ? (
          <p className="asset-warning">One of the selected assets could not be resolved.</p>
        ) : (
          <>
            <p>
              Rig: <strong>{compatibility.retargetStatus}</strong> ·{' '}
              {compatibility.compatible ? 'compatible' : 'incompatible'}
            </p>
            {compatibility.missingSlots.length > 0 && (
              <p className="asset-warning" data-testid="apply-missing-slots">
                Missing required slots: {compatibility.missingSlots.join(', ')}
              </p>
            )}
            {compatibility.issues.slice(0, 6).map((issue, index) => (
              <p key={index} className={issue.severity === 'error' ? 'asset-warning' : 'muted'}>
                {issue.message}
              </p>
            ))}
          </>
        )}
        <p className="muted">
          Affected instance overrides on this character: {affectedOverrides}
        </p>
        <p className="muted">
          Replay fixtures to run: {replayFixtures.join(', ') || 'none declared'}
        </p>
      </section>

      <div className="asset-dialog__actions">
        <button
          type="button"
          disabled={compatibility === null || !compatibility.compatible}
          title={
            backendOnline === false
              ? 'Applies for preview only — a static host cannot write the project.'
              : 'Stage the assignment through an atomic transaction'
          }
          onClick={submit}
          data-testid="apply-submit"
        >
          {backendOnline === false ? 'Apply for preview' : 'Apply'}
        </button>
        <button type="button" onClick={() => close(null)} data-testid="apply-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Create Variant / Fork / Duplicate. */
export function DeriveAssetDialog() {
  const selection = useChamber((state) => state.librarySelection);
  const derive = useChamber((state) => state.deriveAsset);
  const close = useChamber((state) => state.openLibraryDialog);
  const backendOnline = useChamber((state) => state.backendOnline);

  const [mode, setMode] = useState<'variant' | 'fork' | 'duplicate'>('variant');
  const [newAssetId, setNewAssetId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [forkIntent, setForkIntent] = useState('');

  const explanation = {
    variant: 'Stays attached to the parent and stores only the difference. The parent’s fixes reach it.',
    fork: 'Takes a snapshot and cuts the link. The parent can be deleted; the origin is kept for comparison only.',
    duplicate: 'A new base asset that merely starts here. No parent relationship is implied.',
  }[mode];

  return (
    <div className="asset-dialog" role="dialog" aria-label="Create derived asset" data-testid="derive-asset-dialog">
      <h3>Create derived asset</h3>
      <p className="muted">
        From <code>{selection?.assetId ?? '—'}</code> v{selection?.version ?? '—'}
      </p>

      <fieldset>
        <legend>Kind</legend>
        {(['variant', 'fork', 'duplicate'] as const).map((entry) => (
          <label key={entry} className="asset-dialog__radio">
            <input
              type="radio"
              name="derive-mode"
              checked={mode === entry}
              onChange={() => setMode(entry)}
              data-testid={`derive-mode-${entry}`}
            />
            {entry}
          </label>
        ))}
      </fieldset>
      <p className="muted" data-testid="derive-explanation">
        {explanation}
      </p>

      <label>
        New asset id
        <input
          value={newAssetId}
          onChange={(event) => setNewAssetId(event.target.value)}
          placeholder="humanoid-third-person-heavy"
          data-testid="derive-asset-id"
        />
      </label>
      <label>
        Display name
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          data-testid="derive-display-name"
        />
      </label>
      {mode === 'fork' && (
        <label>
          Fork intent
          <input
            value={forkIntent}
            onChange={(event) => setForkIntent(event.target.value)}
            placeholder="why this needs to diverge permanently"
            data-testid="derive-fork-intent"
          />
        </label>
      )}

      <div className="asset-dialog__actions">
        <button
          type="button"
          disabled={
            backendOnline === false ||
            newAssetId.trim() === '' ||
            (mode === 'fork' && forkIntent.trim() === '')
          }
          title={
            backendOnline === false
              ? 'Publishing a derived asset needs the local API server.'
              : undefined
          }
          onClick={() =>
            void derive(mode, newAssetId.trim(), displayName.trim() || newAssetId.trim(), forkIntent.trim())
          }
          data-testid="derive-submit"
        >
          Create {mode}
        </button>
        <button type="button" onClick={() => close(null)} data-testid="derive-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}
