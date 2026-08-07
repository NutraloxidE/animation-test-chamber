/**
 * One real browser router.
 *
 * `BrowserRouter`, not `HashRouter`: the visible path has to remain
 * `/edit/rig/…` (work package §5.3), because a `#/edit/rig/…` URL is not a path
 * a server, a crawler or a deep link can reason about.
 *
 * Route matching and navigation belong to the router. A second hand-written
 * routing state machine in Zustand is explicitly forbidden (§5.2), and for a
 * concrete reason: it would need its own history handling, and browser Back
 * would then disagree with the app's idea of where it is.
 *
 * `useTransitions={false}` is load-bearing, and the reason is worth recording
 * because the symptom was so misleading.
 *
 * React Router v7 commits the location inside `React.startTransition`. That is
 * the right default for an app whose routes suspend — the previous screen stays
 * up instead of flashing a fallback — but it makes the location a *low
 * priority* update, and this app has no lazy routes and no route-level Suspense
 * to benefit from it. Meanwhile the chamber polls the engine into React state
 * every 100ms (`App.tsx`), and a full chamber render under software-rendered
 * WebGL takes longer than that. Each poll preempted the in-flight transition
 * and restarted it, so the location update was perpetually re-rendered and
 * never committed — while `history.pushState` had already moved the address bar
 * synchronously.
 *
 * The result was a URL and a screen that disagreed indefinitely: `/edit/rig/b`
 * in the address bar, character `a` still rendered, and no error anywhere. It
 * reproduced on every Playwright project and stayed invisible on a fast machine,
 * where the render finished inside one poll interval.
 *
 * The URL is this app's selector (DECISION 0012). A selector that applies only
 * when the renderer happens to be idle is not a selector, so the location moves
 * at default priority.
 */
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ROUTES, prefabAnimationWorkspacePath, prefabEditorPath, rigEditorPath, sceneEditorPath } from './routes.ts';
import { PlayScenePage } from '../game-runtime/PlayScenePage.tsx';
import { App } from '../App.tsx';
import { NotFoundPage } from './NotFoundPage.tsx';
import { SceneEditorPage } from '../scene-editor/SceneEditorPage.tsx';
import { defaultSceneEditorSceneId } from '../scene-editor/resolve-scene-editor-target.ts';
import { CharacterListPage, SceneListPage } from './ListPages.tsx';
import { PrefabListPage } from '../prefab-editor/PrefabListPage.tsx';
import { PrefabEditorPage } from '../prefab-editor/PrefabEditorPage.tsx';
import { AnimationWorkspaceRoute } from '../prefab-editor/AnimationWorkspaceRoute.tsx';
import { RigEditorListPage } from '../prefab-editor/RigEditorListPage.tsx';
import { legacyRigWorkspaceRedirect } from '../prefab-editor/resolve-prefab-editor-target.ts';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { routeId } from './routes.ts';
import { useParams } from 'react-router-dom';

/**
 * `/edit/rig/:legacyCharacterId` — a redirect, and only a redirect (§4).
 *
 * The old editor must not mount first. Mounting it would rebuild an edit
 * session for a Character, run its preview runtime, and leave a frame of the
 * legacy surface on screen — all for a URL whose only remaining job is to keep
 * old bookmarks resolving.
 *
 * The destination comes from the same table the migration used, so a bookmark
 * lands on the Prefab the Character actually became. A legacy id with no
 * mapping is a not-found rather than "some Prefab": guessing here would make a
 * dead bookmark look like a successful edit of the wrong asset.
 */
function LegacyRigRedirect(): JSX.Element {
  const characterId = routeId(useParams().characterId);
  const result = legacyRigWorkspaceRedirect(browserPrefabRegistry(), characterId);
  if (result.status === 'resolved') {
    return <Navigate to={prefabAnimationWorkspacePath(result.prefabId, result.nodeId, result.componentId)} replace />;
  }
  if (result.status === 'ambiguous') {
    return (
      <section className="empty-state" data-testid="legacy-rig-ambiguous">
        <h2>Choose an exact Animator</h2>
        <p>This legacy URL maps to more than one Animator, so none was guessed.</p>
        <ul>{result.candidates.map((candidate) => <li key={`${candidate.nodeId}/${candidate.componentId}`}><a href={prefabAnimationWorkspacePath(result.prefabId, candidate.nodeId, candidate.componentId)}>{candidate.nodeDisplayName}: {candidate.nodeId}/{candidate.componentId}</a></li>)}</ul>
      </section>
    );
  }
  {
    return (
      <NotFoundPage
        title={result.status === 'no-animator' ? `No Animator in "${result.prefabId}"` : characterId === null ? 'No character named in the URL' : `No Prefab for "${characterId}"`}
        detail="Rig routes redirect only when the exact native Animator is deterministic. They never open an editor of their own."
        links={[{ to: ROUTES.prefabs, label: 'Prefabs' }]}
      />
    );
  }
}

/**
 * `/` opens the Prefab inventory.
 *
 * It used to redirect to "the default Character", which meant the app's front
 * door depended on `project.activeCharacterId` — a field the cutover removes.
 * The inventory needs no such default: it shows what the repository contains
 * and lets the URL name what happens next.
 *
 * `replace`, so the redirect does not sit in history — Back should leave the
 * app, not bounce through `/` and immediately forward again.
 */
export function AppRouter(): JSX.Element {
  return (
    <BrowserRouter useTransitions={false}>
      <Routes>
        <Route path={ROUTES.root} element={<PlayScenePage />} />
        <Route path={ROUTES.playScene} element={<PlayScenePage />} />
        <Route path={ROUTES.assets} element={<App />} />
        <Route path={ROUTES.prefabs} element={<PrefabListPage />} />
        <Route path={ROUTES.prefabEditor} element={<PrefabEditorPage />} />
        {/*
          Listed before nothing in particular — React Router matches by
          specificity, not order — but kept next to the composition route it
          extends, because the two share a lineage and are read together.
        */}
        <Route
          path={ROUTES.prefabAnimationWorkspace}
          element={<AnimationWorkspaceRoute />}
        />
        <Route path={ROUTES.rigEditor} element={<LegacyRigRedirect />} />
        <Route path={ROUTES.sceneEditor} element={<SceneEditorPage />} />
        <Route path={ROUTES.characters} element={<CharacterListPage />} />
        <Route path={ROUTES.scenes} element={<SceneListPage />} />
        <Route path="/edit/rig" element={<RigEditorListPage />} />
        <Route path="/edit/prefab" element={<PrefabEditorPage />} />
        <Route path="/edit/scene" element={<SceneEditorPage />} />
        <Route
          path="*"
          element={
            <NotFoundPage
              title="No such page"
              detail="The editor has two routes: /edit/prefab/:prefabId and /edit/scene/:sceneId."
              links={[
                { to: ROUTES.prefabs, label: 'Prefabs' },
                { to: ROUTES.scenes, label: 'Scenes' },
              ]}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export { prefabEditorPath, rigEditorPath, sceneEditorPath, defaultSceneEditorSceneId };
