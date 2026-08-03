/**
 * What the selected instance *references* — and what editing it would cost.
 *
 * These rows are links, not editors. Opening one takes the user to
 * Project/Assets, which owns shared definitions, and deliberately leaves the
 * scene selection alone: they asked to look at the character, not to stop
 * editing the instance. That is the whole reason scene selection and asset
 * selection are separate fields.
 */
import { useChamber } from '../../store.ts';
import { ScopeBadge } from './ScopeBadge.tsx';

export function SharedDefinitionsSection({ instanceId }: { instanceId: string }) {
  const sharedAssets = useChamber((state) => state.sharedAssetsFor(instanceId));
  const instance = useChamber((state) =>
    state.stagedWorld.instances.find((entry) => entry.id === instanceId),
  );
  const openCharacter = useChamber((state) => state.openCharacterDefinition);
  const openInCharacterLab = useChamber((state) => state.openInCharacterLab);
  const worldId = useChamber((state) => state.stagedWorld.id);

  if (!instance) return null;

  const rows: [string, string][] = sharedAssets
    ? [
        ['Behavior', `${sharedAssets.behavior.assetId}@${sharedAssets.behavior.version}`],
        ['Motion set', `${sharedAssets.motionSet.assetId}@${sharedAssets.motionSet.version}`],
        ['Rig', `${sharedAssets.rig.assetId}@${sharedAssets.rig.version}`],
      ]
    : [];

  return (
    <section className="inspector__section" data-testid="inspector-shared-definitions">
      <h3>
        Shared Definitions
        <ScopeBadge scope="SHARED" />
      </h3>
      <dl className="inspector__provenance">
        <dt>Source character</dt>
        <dd data-testid="world-inspector-character">{instance.source.characterId}</dd>
        {rows.map(([label, value]) => (
          <div key={label} className="inspector__provenance-row">
            <dt>{label}</dt>
            <dd data-testid={`world-inspector-${label.toLowerCase().replace(' ', '-')}`}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="inspector__sharing">
        These definitions are <b>shared</b>: changing them affects every instance referencing this
        character. Everything under Loadout and Transform is <b>this instance only</b>.
      </p>
      {/* Two actions, because they were one and they are different questions.
          "Open in Character Lab" goes to the authoring stage for this shared
          definition; "Open Assets" goes to the asset browser. Both leave the
          scene selection exactly where it is — the user asked to look at a
          shared definition, not to stop editing this instance. */}
      <div className="inspector__actions">
        <button
          type="button"
          className="inspector__action"
          data-testid="open-source-character-lab"
          onClick={() =>
            openInCharacterLab(instance.source.characterId, {
              returnLabel: `${instance.id} in ${worldId}`,
            })
          }
        >
          Open in Character Lab
        </button>
        <button
          type="button"
          className="inspector__action"
          data-testid="open-source-character"
          onClick={() => openCharacter(instance.source.characterId)}
        >
          Open Assets
        </button>
      </div>
    </section>
  );
}
