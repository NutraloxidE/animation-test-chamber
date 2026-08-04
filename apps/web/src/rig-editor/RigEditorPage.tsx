/**
 * `/edit/rig/:characterId`.
 *
 * The existing chamber is already the Rig Editor — it is the screen the
 * animation tuning workflow was built on — so this page does not rebuild it. It
 * adds the two things the route brought with it: an identity header naming the
 * exact Character being edited, and the guarantee that the route, not a global
 * `activeCharacterId`, decides which Character that is (work package §10.2).
 *
 * The store still holds an `activeCharacterId`; what changed is its direction
 * of travel. It used to be *set* by a picker and read by every panel, so a
 * panel reading a stale value edited the wrong character while looking correct.
 * Now the route sets it, once, on entry — and a character switcher navigates
 * instead of assigning.
 */
import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { App } from '../App.tsx';
import { useChamber } from '../store.ts';
import { routeId, rigEditorPath } from '../app/routes.ts';
import { NotFoundPage } from '../app/NotFoundPage.tsx';
import { resolveRigEditorTarget } from './resolve-rig-editor-target.ts';

export function RigEditorPage(): JSX.Element {
  const characterId = routeId(useParams().characterId);
  const canonicalProject = useChamber((state) => state.canonicalProject);
  const activeCharacterId = useChamber((state) => state.activeCharacterId);
  const setActiveCharacter = useChamber((state) => state.setActiveCharacter);
  const revisionId = useChamber((state) => state.canonicalProject.revisionId);

  const target = resolveRigEditorTarget(canonicalProject, characterId);

  /*
   * The route drives the session, not the other way round. `setActiveCharacter`
   * already rebuilds the edit session and the preview runtime from scratch,
   * which is what stops Character A's unstaged preview leaking into Character B
   * (§10.5) — carrying staged edits across would apply one character's
   * decisions to another's assets.
   */
  useEffect(() => {
    if (target.status !== 'resolved') return;
    if (activeCharacterId === target.characterId) return;
    setActiveCharacter(target.characterId);
  }, [target.status, target.status === 'resolved' ? target.characterId : null, activeCharacterId, setActiveCharacter]);

  if (target.status !== 'resolved') {
    return (
      <NotFoundPage
        title={
          target.status === 'missing'
            ? `No character "${target.characterId}"`
            : 'No character named in the URL'
        }
        detail="The URL names the character being edited. It is never guessed at, and never falls back to another character."
        links={target.available.map((character) => ({
          to: rigEditorPath(character.id),
          label: `${character.displayName} (${character.id})`,
        }))}
      />
    );
  }

  /*
   * The store is rebuilt asynchronously by the effect above, so for one render
   * after a route change the chamber still holds the previous character. It is
   * shown as loading rather than rendered with the old document: a frame of the
   * wrong character's graph is exactly the confusion the route identity exists
   * to remove.
   */
  const ready = activeCharacterId === target.characterId;

  return (
    <div className="rig-editor">
      <header className="target-header" data-testid="rig-target-header">
        <span className="target-header__kind">Rig Editor</span>
        <span className="target-header__name" data-testid="rig-target-name">
          {target.character.displayName}
        </span>
        <span className="target-header__id" data-testid="rig-target-id">
          ID: {target.characterId}
        </span>
        <span className="target-header__revision">Repository revision: {revisionId}</span>
        <nav className="target-header__switch">
          {canonicalProject.characters
            .filter((character) => character.id !== target.characterId)
            .map((character) => (
              /*
               * A switcher that navigates. It does *not* assign
               * activeCharacterId and hope every panel follows — the URL is the
               * selector, so the address bar and the screen cannot disagree.
               */
              <Link key={character.id} to={rigEditorPath(character.id)}>
                {character.displayName}
              </Link>
            ))}
        </nav>
      </header>
      {ready ? <App /> : <p className="target-header__loading">Loading {target.characterId}…</p>}
    </div>
  );
}
