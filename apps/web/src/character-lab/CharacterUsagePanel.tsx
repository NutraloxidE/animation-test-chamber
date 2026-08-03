/**
 * Every World Instance that would be affected by an edit here.
 *
 * Character Lab always edits a *shared* definition, and the preview stage shows
 * exactly one body — which is precisely the arrangement that lets a user
 * believe they are changing the thing on screen. Naming the instances is the
 * cheapest honest correction: "this changes two characters in demo-world" is a
 * sentence, not a badge someone has to already understand.
 */
import { useChamber } from '../store.ts';

export interface CharacterUsage {
  worldId: string;
  instanceId: string;
  displayName: string;
}

export function useCharacterUsage(characterId: string): CharacterUsage[] {
  const world = useChamber((state) => state.stagedWorld);
  return world.instances
    .filter((instance) => instance.source.characterId === characterId)
    .map((instance) => ({
      worldId: world.id,
      instanceId: instance.id,
      displayName: instance.displayName,
    }));
}

export function CharacterUsagePanel({ characterId }: { characterId: string }) {
  const usage = useCharacterUsage(characterId);
  const selectScene = useChamber((state) => state.selectScene);
  const setPrimaryWorkspace = useChamber((state) => state.setPrimaryWorkspace);

  return (
    <section className="character-usage" data-testid="character-usage">
      <header className="character-usage__header">
        <h3>Used by</h3>
        <span className="workspace__badge" data-testid="character-shared-scope">
          SHARED CHARACTER DEFINITION
        </span>
      </header>

      {usage.length === 0 ? (
        <p className="workspace__hint" data-testid="character-usage-empty">
          No World Instance references this Character yet. Editing it changes nothing that is
          currently placed.
        </p>
      ) : (
        <>
          <p className="workspace__hint" data-testid="character-usage-count">
            Changes here affect {usage.length} World{' '}
            {usage.length === 1 ? 'Instance' : 'Instances'}.
          </p>
          <ul className="character-usage__list">
            {usage.map((entry) => (
              <li key={entry.instanceId}>
                <button
                  type="button"
                  data-testid={`character-usage-${entry.instanceId}`}
                  onClick={() => {
                    // Goes to the instance, which is a World question — so it
                    // changes the stage and the scene selection together, and
                    // nothing about the definition being edited.
                    selectScene({ kind: 'instance', instanceId: entry.instanceId });
                    setPrimaryWorkspace('world');
                  }}
                >
                  {entry.worldId} / {entry.instanceId}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
