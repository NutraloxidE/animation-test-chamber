/**
 * Route-to-Scene resolution. Same rule as the Rig resolver, same reason.
 *
 * `/edit/scene/scene-a` must never edit `scene-b`, and an unknown id renders a
 * stable not-found state with links back to what exists — never the first scene
 * in the project (work package §4.2).
 *
 * `activeSceneId` is consulted only to answer "where should a scene *list* send
 * someone", never to answer "what is this page editing". A route that fell back
 * to it would make a stale preference silently redirect an explicit link.
 */
import type { ProjectDefinition, SceneDefinition } from '@atc/schema';

export type SceneEditorTarget =
  | { status: 'resolved'; sceneId: string; scene: SceneDefinition }
  | { status: 'missing'; sceneId: string; available: SceneDefinition[] }
  | { status: 'no-target'; available: SceneDefinition[] };

export function resolveSceneEditorTarget(
  project: ProjectDefinition,
  sceneId: string | null,
): SceneEditorTarget {
  const available = [...project.scenes];
  if (sceneId === null) return { status: 'no-target', available };

  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene) return { status: 'missing', sceneId, available };

  return { status: 'resolved', sceneId, scene };
}

/**
 * Where a scene list should send someone, or `null` when there is nothing to
 * open.
 *
 * `null` is a legitimate answer, not an error: a repository that only authors
 * reusable Characters has no Scene, and the Rig Editor needs none. Creating one
 * here so the link had a destination would persist a Scene nobody composed.
 */
export function defaultSceneEditorSceneId(project: ProjectDefinition): string | null {
  const active = project.scenes.find((entry) => entry.id === project.activeSceneId);
  return (active ?? project.scenes[0])?.id ?? null;
}
