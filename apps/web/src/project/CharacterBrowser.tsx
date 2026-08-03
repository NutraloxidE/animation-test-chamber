/**
 * The project's canonical Characters, as the thing you act on.
 *
 * This is the list `Character render preset` used to stand in for. The rows are
 * Character Definitions — the ids a Runtime Instance actually references — and
 * each one says how it renders, what it references, and how many World
 * Instances would feel a change to it before you make one.
 */
import { useChamber } from '../store.ts';
import {
  describeCharacterRender,
  resolveCharacterRender,
} from '../character-lab/canonical-character-render.ts';

export function CharacterBrowser() {
  const characters = useChamber((state) => state.canonicalProject.characters);
  const world = useChamber((state) => state.stagedWorld);
  const editingCharacterId = useChamber((state) => state.editingCharacterId);
  const openInCharacterLab = useChamber((state) => state.openInCharacterLab);

  return (
    <section className="character-browser" data-testid="character-browser">
      <header className="character-browser__header">
        <h3>Characters</h3>
        <span className="workspace__badge">SHARED DEFINITIONS</span>
      </header>

      <ul className="character-browser__list">
        {characters.map((character) => {
          const render = resolveCharacterRender(character);
          const usage = world.instances.filter(
            (instance) => instance.source.characterId === character.id,
          );
          return (
            <li
              key={character.id}
              className={`character-browser__row${
                character.id === editingCharacterId ? ' is-editing' : ''
              }`}
              data-testid={`character-row-${character.id}`}
            >
              <div className="character-browser__identity">
                <b>{character.displayName}</b>
                <code>{character.id}</code>
              </div>
              <div className="character-browser__meta">
                <span data-testid={`character-row-render-${character.id}`}>
                  {describeCharacterRender(render)}
                </span>
                <span>Rig {render.rigAssetId}</span>
                <span>Behavior {render.behaviorAssetId}</span>
                <span>Motion Set {render.motionSetAssetId}</span>
                {/* Shared impact, before the user opens anything. */}
                <span data-testid={`character-row-usage-${character.id}`}>
                  Used by {usage.length} World {usage.length === 1 ? 'Instance' : 'Instances'}
                </span>
              </div>
              <div className="character-browser__actions">
                <button
                  type="button"
                  data-testid={`character-open-lab-${character.id}`}
                  onClick={() => openInCharacterLab(character.id)}
                >
                  Open in Character Lab
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
