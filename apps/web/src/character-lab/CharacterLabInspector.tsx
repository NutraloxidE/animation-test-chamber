/**
 * The Character Definition's own properties.
 *
 * Everything here is shared. That is stated rather than implied, and the usage
 * list underneath turns "shared" from a word into a list of the instances it
 * means.
 */
import type { CharacterDefinition } from '@atc/schema';
import { useChamber } from '../store.ts';
import { CharacterUsagePanel } from './CharacterUsagePanel.tsx';
import { describeCharacterRender, resolveCharacterRender } from './canonical-character-render.ts';

function AssetRow({ label, assetId, version }: { label: string; assetId: string; version: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {assetId}
        <span className="muted"> @{version}</span>
      </dd>
    </div>
  );
}

export function CharacterLabInspector({ character }: { character: CharacterDefinition }) {
  const openAssets = useChamber((state) => state.openCharacterDefinition);
  const render = resolveCharacterRender(character);

  return (
    <div className="character-lab__inspector" data-testid="character-lab-inspector">
      <section>
        <h3>Identity</h3>
        <dl className="character-lab__grid">
          <div>
            <dt>Character ID</dt>
            <dd data-testid="character-lab-id">{character.id}</dd>
          </div>
          <div>
            <dt>Display Name</dt>
            <dd data-testid="character-lab-name">{character.displayName}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>Model</h3>
        <dl className="character-lab__grid">
          <div>
            <dt>Model asset</dt>
            <dd data-testid="character-lab-model">
              {render.modelAssetPath ?? 'none — procedural fallback'}
            </dd>
          </div>
          <div>
            <dt>Renderer</dt>
            {/* The fallback is labelled, always. A procedural body that looked
                like a deliberate art choice would be the same failure as a
                model silently rendering as somebody else's. */}
            <dd data-testid="character-lab-render-kind">{describeCharacterRender(render)}</dd>
          </div>
        </dl>
        {render.adapterMissing && (
          <p className="character-lab__warning" data-testid="character-lab-adapter-missing">
            This Character declares a model asset that no render adapter matches yet.
          </p>
        )}
      </section>

      <section>
        <h3>Capsule</h3>
        <dl className="character-lab__grid">
          <div>
            <dt>Radius</dt>
            <dd data-testid="character-lab-capsule-radius">{character.capsuleRadius}</dd>
          </div>
          <div>
            <dt>Height</dt>
            <dd data-testid="character-lab-capsule-height">{character.capsuleHeight}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>Animation assignment</h3>
        <dl className="character-lab__grid" data-testid="character-lab-animation">
          <AssetRow
            label="Behavior"
            assetId={character.animation.behavior.assetId}
            version={character.animation.behavior.version}
          />
          <AssetRow
            label="Motion Set"
            assetId={character.animation.motionSet.assetId}
            version={character.animation.motionSet.version}
          />
          <AssetRow
            label="Rig"
            assetId={character.animation.rig.assetId}
            version={character.animation.rig.version}
          />
          {character.animation.tuning && (
            <AssetRow
              label="Tuning"
              assetId={character.animation.tuning.assetId}
              version={character.animation.tuning.version}
            />
          )}
        </dl>
        {/* Assignment itself stays in Project / Assets, where the SHARED badge
            and the save-destination flow already live. This is a link to it,
            not a second place to change it. */}
        <button
          type="button"
          data-testid="character-lab-open-assets"
          onClick={() => openAssets(character.id)}
        >
          Open Assets
        </button>
      </section>

      <CharacterUsagePanel characterId={character.id} />
    </div>
  );
}
