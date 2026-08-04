/**
 * `/characters` and `/scenes` — the supporting routes.
 *
 * They exist so the two editors have somewhere to link back to, and so an
 * unknown id has an honest destination other than "the first item". A scene
 * list with nothing in it says so rather than inventing a Scene: a repository
 * that only authors reusable Characters is a legitimate shape.
 */
import { Link } from 'react-router-dom';
import { useChamber } from '../store.ts';
import { rigEditorPath, sceneEditorPath } from './routes.ts';

export function CharacterListPage(): JSX.Element {
  const characters = useChamber((state) => state.canonicalProject.characters);
  return (
    <main className="resource-list" data-testid="character-list">
      <h1>Characters</h1>
      <ul>
        {characters.map((character) => (
          <li key={character.id}>
            <Link to={rigEditorPath(character.id)}>
              {character.displayName} <code>{character.id}</code>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

export function SceneListPage(): JSX.Element {
  const scenes = useChamber((state) => state.canonicalProject.scenes);
  return (
    <main className="resource-list" data-testid="scene-list">
      <h1>Scenes</h1>
      {scenes.length === 0 ? (
        <p>This project has no scenes. Characters can still be tuned in the Rig Editor.</p>
      ) : (
        <ul>
          {scenes.map((scene) => (
            <li key={scene.id}>
              <Link to={sceneEditorPath(scene.id)}>
                {scene.displayName} <code>{scene.id}</code>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
