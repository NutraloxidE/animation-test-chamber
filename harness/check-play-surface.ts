import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const router = readFileSync(resolve(root, 'apps/web/src/app/router.tsx'), 'utf8');
const play = readFileSync(resolve(root, 'apps/web/src/game-runtime/PlayScenePage.tsx'), 'utf8');
const overlay = readFileSync(resolve(root, 'apps/web/src/game-ui/GameOverlay.tsx'), 'utf8');
const fail = (message: string): never => { throw new Error(`play-surface: ${message}`); };

if (!router.includes('path={ROUTES.root} element={<PlayScenePage />}')) fail('/ must mount PlayScenePage directly');
if (!router.includes('path={ROUTES.playScene} element={<PlayScenePage />}')) fail('/play/:sceneId must mount PlayScenePage');
for (const forbidden of ['EditSession', 'AuthoringSession', 'SceneEditorPage', 'PrefabEditorPage', '<OrbitControls']) if (play.includes(forbidden)) fail(`play host contains forbidden editor surface: ${forbidden}`);
for (const required of ['canonicalProject', 'BrowserInputSampler', 'injectHumanIntent', 'cameraYawRad', 'activeCameraGameObjectId', 'AuthoredCamera', 'GameObjectRenderer', 'GameOverlay']) if (!play.includes(required)) fail(`play host lacks ${required}`);
if (!overlay.includes('game-overlay')) fail('GameOverlay does not own the game overlay surface');
console.log('PLAY SURFACE: PASS');
