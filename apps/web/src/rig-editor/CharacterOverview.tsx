/**
 * The Character Overview (work package §6).
 *
 * The question this answers, without opening the Asset Library: *what am I
 * actually editing, and who else does it belong to?*
 *
 * Every reference the Rig Editor can change was previously visible only as a
 * consequence — you found out a Behavior was shared when a save dialog offered
 * you a variant, or later, when another Character's feel had moved. Sharing is
 * legitimate and often intended; what is not acceptable is discovering it
 * afterwards. So each row names the exact asset and version and says either
 * ONLY THIS CHARACTER or SHARED BY N, and a shared row lists the holders by
 * name.
 *
 * The counts come from `describeCharacterBindings`, the same function the save
 * destinations derive their blast radius from. Two implementations of "who holds
 * this" is the failure worth designing against: the badge could say "only this
 * character" while the save reached four others, and both would look right.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AssetReference } from '@atc/schema';
import type {
  BindingFact,
  CharacterBindingDescription,
  ModelBindingFact,
} from '@atc/animation-asset-runtime';
import { otherHolders } from '@atc/animation-asset-runtime';
import { useChamber, useCharacterBindings, useCharacterPresentation } from '../store.ts';
import { rigEditorPath } from '../app/routes.ts';

/**
 * `ONLY THIS CHARACTER` or `SHARED BY N`, plus `OVERRIDDEN` / `INHERITED` when
 * they apply.
 *
 * Ownership is always stated, *and then* qualified — never replaced. A Behavior
 * shared by five that this Character also patches locally is both things, and
 * showing only OVERRIDDEN would understate the blast radius of publishing it:
 * the reader would see "I have local changes" where the fact that matters is
 * "and four other Characters are on this asset".
 */
function OwnershipBadge({ fact }: { fact: BindingFact | ModelBindingFact }) {
  const shared = fact.usedByCharacterIds.length > 1;
  return (
    <>
      <span
        className={`badge badge--${shared ? 'shared' : 'exclusive'}`}
        data-testid="ownership-badge"
      >
        {shared ? `SHARED BY ${fact.usedByCharacterIds.length}` : 'ONLY THIS CHARACTER'}
      </span>
      {(fact.ownership === 'overridden' || fact.ownership === 'inherited') && (
        <span
          className={`badge badge--${fact.ownership}`}
          data-testid="ownership-qualifier-badge"
        >
          {fact.ownership === 'overridden' ? 'OVERRIDDEN' : 'INHERITED'}
        </span>
      )}
    </>
  );
}

/**
 * The other Characters a change here would reach, by display name.
 *
 * Names *and* ids: a display name is what a human recognises, and an id is what
 * they can act on. §6 requires the exact list, not a count — "shared by 3" tells
 * you to be careful, and only the list tells you what you are about to change.
 */
function Holders({
  fact,
  characterId,
  displayNameOf,
}: {
  fact: BindingFact | ModelBindingFact;
  characterId: string;
  displayNameOf: (id: string) => string;
}) {
  const others = otherHolders(fact, characterId);
  if (others.length === 0) return null;
  return (
    <p className="overview__holders" data-testid="ownership-holders">
      Also used by: {others.map((id) => `${displayNameOf(id)} (${id})`).join(' · ')}
    </p>
  );
}

function ReferenceRow({
  label,
  fact,
  characterId,
  displayNameOf,
  onOpen,
  testId,
}: {
  label: string;
  fact: BindingFact;
  characterId: string;
  displayNameOf: (id: string) => string;
  onOpen: (reference: AssetReference) => void;
  testId: string;
}) {
  return (
    <div className="overview__row" data-testid={testId}>
      <span className="overview__label">{label}</span>
      <button
        type="button"
        className="overview__asset"
        onClick={() => onOpen(fact.reference)}
        title="Open in the Asset Library"
      >
        {fact.reference.assetId}@{fact.reference.version}
      </button>
      <OwnershipBadge fact={fact} />
      <Holders fact={fact} characterId={characterId} displayNameOf={displayNameOf} />
    </div>
  );
}

/** `INCOMPATIBLE` / `RETARGET REQUIRED`, and nothing at all when direct. */
function CompatibilityBadge({ binding }: { binding: CharacterBindingDescription }) {
  const { status, detail } = binding.rigCompatibility;
  if (status === undefined) {
    return (
      <span className="badge badge--unknown" data-testid="rig-compatibility-badge">
        COMPATIBILITY UNKNOWN
      </span>
    );
  }
  if (status === 'direct-compatible') {
    return (
      <span className="badge badge--exclusive" data-testid="rig-compatibility-badge">
        COMPATIBLE
      </span>
    );
  }
  return (
    <span
      className={`badge badge--${status === 'retarget-compatible' ? 'retarget' : 'incompatible'}`}
      data-testid="rig-compatibility-badge"
      title={detail}
    >
      {status === 'retarget-compatible' ? 'RETARGET REQUIRED' : 'INCOMPATIBLE'}
    </span>
  );
}

export function CharacterOverview() {
  const bindings = useCharacterBindings();
  const presentation = useCharacterPresentation();
  const characters = useChamber((state) => state.canonicalProject.characters);
  const setWorkspaceMode = useChamber((state) => state.setWorkspaceMode);
  const selectLibraryAsset = useChamber((state) => state.selectLibraryAsset);
  const navigate = useNavigate();

  /*
   * Expanded on a desktop, one tappable line below 900px.
   *
   * The same shape the Hierarchy and the panel sheet already take at narrow
   * widths, and for the same reason: a persistent 40vh block above the chamber
   * left the 320px layout with too little height for the scene, and the bottom
   * sheet's handle ended up underneath the viewport's own controls. The summary
   * still names the Character at every width — what collapses is the reference
   * list, not the identity.
   */
  const [expanded, setExpanded] = useState(() => window.matchMedia('(min-width: 901px)').matches);

  const binding = bindings.find((entry) => entry.characterId === presentation.characterId);
  if (!binding) return null;

  const displayNameOf = (id: string): string =>
    characters.find((character) => character.id === id)?.displayName ?? id;

  /** Opens the asset's own detail view, which owns dependencies and Used By. */
  const openAsset = (reference: AssetReference): void => {
    selectLibraryAsset({
      assetType: reference.assetType,
      assetId: reference.assetId,
      version: reference.version,
    });
    setWorkspaceMode('asset-library');
  };

  const model = binding.model;

  return (
    <section className={`overview${expanded ? ' is-expanded' : ''}`} data-testid="character-overview">
      <header className="overview__header">
        <span className="overview__kind">Character</span>
        <strong data-testid="overview-character-name">{binding.displayName}</strong>
        <code data-testid="overview-character-id">ID: {binding.characterId}</code>
        <button
          type="button"
          className="overview__toggle"
          onClick={() => setExpanded(!expanded)}
          data-testid="overview-toggle"
          aria-expanded={expanded}
        >
          {expanded ? 'Hide bindings' : 'Show bindings'}
        </button>
      </header>
      {expanded && (
      <div className="overview__body" data-testid="overview-body">

      <div className="overview__row" data-testid="overview-model">
        <span className="overview__label">Model</span>
        <code className="overview__asset overview__asset--static">{model.idOrPath}</code>
        <OwnershipBadge fact={model} />
        {/*
          A preview override is called out here as well as in the Hierarchy,
          because this panel is the answer to "what is authored" — and a panel
          that showed the canonical model while the Viewport showed something
          else, silently, would recreate the original bug in a new place.
        */}
        {presentation.model.isPreviewOverridden && (
          <span className="badge badge--preview" data-testid="overview-preview-badge">
            PREVIEW ONLY: showing{' '}
            {presentation.model.effective.kind === 'procedural-humanoid'
              ? presentation.model.effective.presetId
              : presentation.model.effective.assetPath}
          </span>
        )}
        <Holders fact={model} characterId={binding.characterId} displayNameOf={displayNameOf} />
      </div>

      <ReferenceRow
        label="Rig"
        fact={binding.rig}
        characterId={binding.characterId}
        displayNameOf={displayNameOf}
        onOpen={openAsset}
        testId="overview-rig"
      />
      <div className="overview__row" data-testid="overview-rig-compatibility">
        <span className="overview__label">Rig compatibility</span>
        <code className="overview__asset overview__asset--static">
          clips authored for {binding.rigCompatibility.motionSetRigId} · character rig{' '}
          {binding.rigCompatibility.characterRigId}
        </code>
        <CompatibilityBadge binding={binding} />
      </div>

      <ReferenceRow
        label="Behavior / Animator"
        fact={binding.behavior}
        characterId={binding.characterId}
        displayNameOf={displayNameOf}
        onOpen={openAsset}
        testId="overview-behavior"
      />
      <ReferenceRow
        label="Motion Set"
        fact={binding.motionSet}
        characterId={binding.characterId}
        displayNameOf={displayNameOf}
        onOpen={openAsset}
        testId="overview-motion-set"
      />
      {binding.tuning ? (
        <ReferenceRow
          label="Tuning"
          fact={binding.tuning}
          characterId={binding.characterId}
          displayNameOf={displayNameOf}
          onOpen={openAsset}
          testId="overview-tuning"
        />
      ) : (
        <div className="overview__row" data-testid="overview-tuning">
          <span className="overview__label">Tuning</span>
          {/* Absent is a real state, and different from "shared with nobody". */}
          <code className="overview__asset overview__asset--static">none</code>
        </div>
      )}

      <div className="overview__row" data-testid="overview-overrides">
        <span className="overview__label">Instance Overrides</span>
        <code className="overview__asset overview__asset--static">
          {binding.instanceOverrideCount}
        </code>
        {binding.instanceOverrideCount > 0 && (
          <>
            <span className="badge badge--overridden">OVERRIDDEN</span>
            <p className="overview__holders" data-testid="overview-override-paths">
              {binding.instanceOverridePaths.join(' · ')}
            </p>
          </>
        )}
      </div>

      <nav className="overview__switch" data-testid="overview-character-switch">
        <span className="overview__label">Other Characters</span>
        {bindings
          .filter((entry) => entry.characterId !== binding.characterId)
          .map((entry) => (
            // Navigation, not assignment: the route is the Character selector.
            <button
              key={entry.characterId}
              type="button"
              onClick={() => navigate(rigEditorPath(entry.characterId))}
            >
              {entry.displayName}
            </button>
          ))}
      </nav>
      </div>
      )}
    </section>
  );
}
