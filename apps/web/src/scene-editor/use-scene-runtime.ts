/**
 * The Scene Editor's `RuntimeScene`, and its lifecycle (§4).
 *
 * This is the seam the production cutover turns on. The Scene Editor used to
 * read `scene.entities` and draw a coloured primitive per `entity.kind`; it now
 * runs the canonical Scene through the *same* resolver and runtime a game host
 * would:
 *
 *   scene.gameObjects
 *     → resolveSceneGameObjects()   (inside instantiateScene)
 *     → instantiateScene()
 *     → RuntimeScene
 *     → GameObjectRenderer
 *
 * No second, web-only Prefab resolver exists (§4.1), and there is no fallback to
 * the entity path (§4.5). If resolution fails the editor shows the issues and
 * draws nothing — because a viewport that quietly rendered `entities` instead
 * would make broken canonical GameObject data look like a working Scene, and
 * would keep the dual system alive indefinitely by hiding every reason to fix it.
 *
 * ## Why the runtime is rebuilt rather than mutated
 *
 * A `RuntimeScene` is built from a Scene *snapshot*. When the staged document
 * changes the old runtime is disposed and a new one instantiated at tick 0, and
 * that is deliberate rather than lazy: `RuntimeScene` holds simulations, intent
 * cursors, animation mixers and cloned skeletons, and a hand-written "apply this
 * one field to the running scene" path would be a second, quietly divergent
 * constructor. Rebuilding also gives the authored-transform edit its honest
 * behaviour — the edit takes effect from the start of the simulation, not as a
 * teleport mid-run (§5.5).
 *
 * The rebuild key is a signature of what the runtime actually reads, so renaming
 * the *Scene* does not throw away a running simulation.
 *
 * ## What this hook deliberately does not own
 *
 * The per-frame counter that makes a moving runtime produce a moving picture.
 * It lives inside `SceneViewport`, because a counter here would live at the
 * *page* level and re-render the hierarchy, the Inspector and the Asset Panel
 * sixty times a second to redraw a canvas none of them appear in.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectDefinition, SceneDefinition, TerrainPreset } from '@atc/schema';
import { instantiateScene, type RuntimeScene } from '@atc/game-object-runtime';
import type { PrefabIssue } from '@atc/prefab-runtime';
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import { browserPrefabRegistry } from '../game-objects/prefab-registry.ts';
import { useChamber } from '../store.ts';

/**
 * A problem the Scene session has to show.
 *
 * Wider than `PrefabIssue` on purpose. Most of these *are* Prefab issues — a
 * missing version, a hash mismatch, an abstract Prefab placed — but
 * instantiation can also fail for reasons the Prefab vocabulary has no code
 * for, and forcing one of its codes onto those would file a runtime failure
 * under a resolution problem nobody could then find.
 */
export interface SceneRuntimeIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface SceneRuntimeHandle {
  /** The running Scene, or `null` while it could not be built. */
  runtime: RuntimeScene | null;
  /** Resolver and runtime problems, shown rather than rendered around (§4.4). */
  issues: SceneRuntimeIssue[];
  playing: boolean;
  setPlaying: (playing: boolean) => void;
  /** Rebuilds every object at tick 0 from the same canonical Scene. */
  reset: () => void;
}

/**
 * What the runtime reads out of a Scene.
 *
 * Everything that changes what gets instantiated, and nothing that does not.
 * `displayName` of the Scene itself is absent on purpose: renaming a Scene must
 * not restart its simulation.
 */
function runtimeSignature(scene: SceneDefinition): string {
  return JSON.stringify({
    gameObjects: scene.gameObjects ?? [],
    intentTracks: scene.intentTracks,
    activeCamera: scene.activeCameraGameObjectId ?? null,
  });
}

const asRuntimeIssue = (issue: PrefabIssue): SceneRuntimeIssue => ({
  code: issue.code,
  severity: issue.severity,
  message: issue.message,
});

export function useSceneRuntime(
  project: ProjectDefinition,
  scene: SceneDefinition,
): SceneRuntimeHandle {
  const animationRegistry = useChamber((state) => state.registry);
  const prefabRegistry = browserPrefabRegistry();
  const [playing, setPlaying] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [handle, setHandle] = useState<{
    runtime: RuntimeScene | null;
    issues: SceneRuntimeIssue[];
  }>({ runtime: null, issues: [] });

  const terrain: TerrainPreset | undefined = useMemo(
    () =>
      TERRAIN_PRESETS.find((preset) => preset.id === project.defaultTerrainPresetId) ??
      TERRAIN_PRESETS[0],
    [project.defaultTerrainPresetId],
  );

  const signature = runtimeSignature(scene);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    let runtime: RuntimeScene | null = null;
    try {
      runtime = instantiateScene({
        scene: sceneRef.current,
        project,
        ...(terrain ? { terrain } : {}),
        services: {
          animationRegistry,
          prefabRegistry,
          clock: { fixedDeltaSeconds: 1 / 60 },
          ...(terrain ? { terrain } : {}),
        },
      });
      setHandle({ runtime, issues: runtime.issues.map(asRuntimeIssue) });
    } catch (failure) {
      /*
       * A throw from instantiation is reported as an issue rather than crashing
       * the route. The Scene Editor is where somebody goes to *fix* a broken
       * Scene, and a page that will not mount is a page they cannot fix it from.
       */
      setHandle({
        runtime: null,
        issues: [
          {
            code: 'scene-instantiation-failed',
            severity: 'error',
            message: failure instanceof Error ? failure.message : String(failure),
          },
        ],
      });
    }

    // Disposed on every rebuild and on unmount, so no mixer, cloned skeleton or
    // component runtime outlives the snapshot it was built for (§4.2).
    return () => {
      runtime?.dispose();
      setHandle({ runtime: null, issues: [] });
    };
  }, [signature, project, animationRegistry, prefabRegistry, terrain, generation]);

  return {
    runtime: handle.runtime,
    issues: handle.issues,
    playing,
    setPlaying,
    reset: () => setGeneration((value) => value + 1),
  };
}
