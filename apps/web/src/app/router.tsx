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
import { useChamber } from '../store.ts';
import { ROUTES, rigEditorPath, sceneEditorPath } from './routes.ts';
import { NotFoundPage } from './NotFoundPage.tsx';
import { RigEditorPage } from '../rig-editor/RigEditorPage.tsx';
import { SceneEditorPage } from '../scene-editor/SceneEditorPage.tsx';
import { defaultRigEditorCharacterId } from '../rig-editor/resolve-rig-editor-target.ts';
import { defaultSceneEditorSceneId } from '../scene-editor/resolve-scene-editor-target.ts';
import { CharacterListPage, SceneListPage } from './ListPages.tsx';

/**
 * `/` redirects to the Rig Editor for the project's default character.
 *
 * `replace`, so the redirect does not sit in history — Back from the rig editor
 * should leave the app, not bounce through `/` and immediately forward again.
 */
function RootRedirect(): JSX.Element {
  const project = useChamber((state) => state.canonicalProject);
  const characterId = defaultRigEditorCharacterId(project);
  if (characterId === null) {
    return (
      <NotFoundPage
        title="This project has no characters"
        detail="A project needs at least one Character Definition before there is anything to tune."
        links={[]}
      />
    );
  }
  return <Navigate to={rigEditorPath(characterId)} replace />;
}

export function AppRouter(): JSX.Element {
  return (
    <BrowserRouter useTransitions={false}>
      <Routes>
        <Route path={ROUTES.root} element={<RootRedirect />} />
        <Route path={ROUTES.rigEditor} element={<RigEditorPage />} />
        <Route path={ROUTES.sceneEditor} element={<SceneEditorPage />} />
        <Route path={ROUTES.characters} element={<CharacterListPage />} />
        <Route path={ROUTES.scenes} element={<SceneListPage />} />
        {/*
          A bare `/edit/rig` with no id is a not-found, not a redirect to
          "some character": the whole point of route identity is that the page
          never picks a target the URL did not name.
        */}
        <Route path="/edit/rig" element={<RigEditorPage />} />
        <Route path="/edit/scene" element={<SceneEditorPage />} />
        <Route
          path="*"
          element={
            <NotFoundPage
              title="No such page"
              detail="The editor has two routes: /edit/rig/:characterId and /edit/scene/:sceneId."
              links={[
                { to: ROUTES.characters, label: 'Characters' },
                { to: ROUTES.scenes, label: 'Scenes' },
              ]}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export { rigEditorPath, sceneEditorPath, defaultSceneEditorSceneId };
