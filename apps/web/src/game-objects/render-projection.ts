/**
 * What the production renderer draws, derived from Components alone (§3).
 *
 * This is the file that ends the "what kind of thing is this" question. The
 * entity renderer answered it with `entity.kind`, and a Character with a lamp
 * on its belt was therefore unrepresentable: an entity was a character *or* a
 * light, and the switch statement made that exclusivity structural rather than
 * authored. A GameObject is neither — it is a node with Components, and what
 * gets drawn is the union of what those Components say.
 *
 * So the projection is a *list of drawable facts per node*, not a kind:
 *
 *   ModelRenderer      → geometry, and which binding it came from
 *   Animator           → what is playing, and against which assignment
 *   CharacterMotor     → whether the simulation owns this node's placement
 *   Light / Camera     → the light or camera this node contributes
 *   EquipmentSockets   → attachment points the renderer can hang things on
 *
 * A node may carry any subset. `model + animator + motor + light` is one node
 * with four facts, and every one of the compositions §3 requires falls out of
 * that without a branch anywhere.
 *
 * Deliberately React-free and Three-free. The property worth testing is "these
 * Components yield exactly these drawables", and that needs no canvas — which
 * is what lets `harness:game-object-renderer` assert the composition rules in
 * Node, in milliseconds, against the canonical project.
 */
import type {
  AnimatorComponent,
  CameraComponent,
  LightComponent,
  RenderableModelBinding,
  TransformDefinition,
} from '@atc/schema';
import type { EquipmentSocketsComponent } from '@atc/schema';
import {
  AnimatorRuntime,
  CameraRuntime,
  CapsuleColliderRuntime,
  CharacterMotorRuntime,
  EquipmentSocketsRuntime,
  LightRuntime,
  ModelRendererRuntime,
  type RuntimeComponent,
  type RuntimeGameObject,
  type RuntimeScene,
} from '@atc/game-object-runtime';

/** A problem that must be visible, never rendered around (§3, last line). */
export interface RenderProjectionIssue {
  code:
    | 'motor-without-animator'
    | 'active-camera-without-camera-component'
    | 'unknown-active-camera'
    | 'scene-resolution-failed';
  message: string;
  gameObjectId?: string;
}

export interface RenderModelFact {
  componentId: string;
  binding: RenderableModelBinding;
  castShadow: boolean;
  receiveShadow: boolean;
}

export interface RenderAnimatorFact {
  componentId: string;
  assignment: AnimatorComponent['assignment'];
  defaultContextKey: string | undefined;
}

export interface RenderLightFact {
  componentId: string;
  lightType: LightComponent['lightType'];
  intensity: number;
  color: string;
  range: number | undefined;
  spotAngleRad: number | undefined;
}

export interface RenderCameraFact {
  componentId: string;
  projection: CameraComponent['projection'];
  fieldOfViewDeg: number | undefined;
  orthographicSize: number | undefined;
}

export interface RenderSocketFact {
  componentId: string;
  sockets: EquipmentSocketsComponent['sockets'];
}

/**
 * One node's drawables.
 *
 * `simulated` rather than `isCharacter`: what the renderer needs to know is
 * whether the placement it was handed came from the simulation or from the
 * document, because a simulated node must not also be carried by its parent
 * (`RuntimeGameObject`'s transform convention). Whether the thing is "a
 * character" is a question for the Prefab list, not for the draw call.
 */
export interface GameObjectRenderNode {
  gameObjectId: string;
  displayName: string;
  enabled: boolean;
  worldTransform: TransformDefinition;
  model: RenderModelFact | undefined;
  animator: RenderAnimatorFact | undefined;
  light: RenderLightFact | undefined;
  camera: RenderCameraFact | undefined;
  sockets: RenderSocketFact | undefined;
  capsule: { radius: number; height: number } | undefined;
  simulated: boolean;
}

export interface GameObjectRenderProjection {
  nodes: GameObjectRenderNode[];
  issues: RenderProjectionIssue[];
}

export interface SceneRenderProjection extends GameObjectRenderProjection {
  /** The node the Scene plays through, resolved through the Component (§3). */
  activeCamera: GameObjectRenderNode | undefined;
}

function enabledOf<T extends { enabled: boolean }>(runtime: T | undefined): T | undefined {
  /*
   * A disabled Component contributes nothing to the frame but still exists on
   * the object. Filtering here rather than at each draw site is what keeps
   * "enabled: false" a statement about *this Component*, not about the node —
   * a Light switched off must not take the model with it.
   */
  return runtime?.enabled ? runtime : undefined;
}

function find<T extends RuntimeComponent>(
  runtime: RuntimeGameObject,
  kind: abstract new (...args: never[]) => T,
): T | undefined {
  return runtime.components.find((component): component is T => component instanceof kind);
}

/** One runtime object and its descendants, flattened into drawables. */
export function projectGameObject(runtime: RuntimeGameObject): GameObjectRenderProjection {
  const nodes: GameObjectRenderNode[] = [];
  const issues: RenderProjectionIssue[] = [];

  for (const object of runtime.walk()) {
    const model = enabledOf(find(object, ModelRendererRuntime));
    const animator = enabledOf(find(object, AnimatorRuntime));
    const motor = enabledOf(find(object, CharacterMotorRuntime));
    const light = enabledOf(find(object, LightRuntime));
    const camera = enabledOf(find(object, CameraRuntime));
    const sockets = enabledOf(find(object, EquipmentSocketsRuntime));
    const capsule = enabledOf(find(object, CapsuleColliderRuntime));

    /*
     * A motor with no Animator is refused rather than drawn as a static model.
     * The motor's whole output is a pose the Animator turns into a frame, so
     * such a node would slide around the terrain in a T-pose — a bug that reads
     * as "the animation broke" long after the Prefab that dropped the Animator
     * was authored.
     */
    if (motor && !animator) {
      issues.push({
        code: 'motor-without-animator',
        gameObjectId: object.id,
        message: `GameObject "${object.id}" has a character-motor but no animator to pose it`,
      });
    }

    nodes.push({
      gameObjectId: object.id,
      displayName: object.definition.displayName,
      enabled: object.definition.enabled,
      worldTransform: object.worldTransform,
      model: model
        ? {
            componentId: model.componentId,
            binding: model.model,
            castShadow: model.castShadow,
            receiveShadow: model.receiveShadow,
          }
        : undefined,
      animator: animator
        ? {
            componentId: animator.componentId,
            assignment: animator.assignment,
            defaultContextKey: animator.defaultContextKey,
          }
        : undefined,
      light: light
        ? {
            componentId: light.componentId,
            lightType: light.lightType,
            intensity: light.intensity,
            color: light.color,
            range: light.range,
            spotAngleRad: light.spotAngleRad,
          }
        : undefined,
      camera: camera
        ? {
            componentId: camera.componentId,
            projection: camera.projection,
            fieldOfViewDeg: camera.fieldOfViewDeg,
            orthographicSize: camera.orthographicSize,
          }
        : undefined,
      sockets: sockets ? { componentId: sockets.componentId, sockets: sockets.sockets } : undefined,
      capsule: capsule ? { radius: capsule.radius, height: capsule.height } : undefined,
      simulated: object.character !== undefined,
    });
  }

  return { nodes, issues };
}

/**
 * A whole `RuntimeScene`, projected (§5).
 *
 * The active camera resolves `activeCameraGameObjectId → RuntimeScene.get(id) →
 * CameraRuntime` and stops there. It does not fall back to "the first object
 * with a camera", because a Scene that names a camera it does not have is a
 * broken Scene, and quietly playing through a different one hides that for as
 * long as some camera exists.
 */
export function projectRuntimeScene(
  scene: RuntimeScene,
  activeCameraGameObjectId: string | undefined,
): SceneRenderProjection {
  const nodes: GameObjectRenderNode[] = [];
  const issues: RenderProjectionIssue[] = [];

  for (const issue of scene.issues) {
    if (issue.severity !== 'error') continue;
    issues.push({ code: 'scene-resolution-failed', message: `${issue.code}: ${issue.message}` });
  }

  for (const object of scene.gameObjects) {
    const projected = projectGameObject(object);
    nodes.push(...projected.nodes);
    issues.push(...projected.issues);
  }

  let activeCamera: GameObjectRenderNode | undefined;
  if (activeCameraGameObjectId !== undefined) {
    const runtime = scene.get(activeCameraGameObjectId);
    if (!runtime) {
      issues.push({
        code: 'unknown-active-camera',
        gameObjectId: activeCameraGameObjectId,
        message: `scene names active camera "${activeCameraGameObjectId}", which is not in the scene`,
      });
    } else {
      // The camera may sit on a child node — a Prefab that puts its lens under
      // a boom arm is ordinary — so the whole subtree is searched.
      activeCamera = projectGameObject(runtime).nodes.find((node) => node.camera !== undefined);
      if (!activeCamera) {
        issues.push({
          code: 'active-camera-without-camera-component',
          gameObjectId: activeCameraGameObjectId,
          message: `GameObject "${activeCameraGameObjectId}" is the active camera but has no camera component`,
        });
      }
    }
  }

  return { nodes, issues, activeCamera };
}

/** Nodes that contribute a frame at all. Draw order is declaration order. */
export function drawableNodes(
  projection: GameObjectRenderProjection,
): GameObjectRenderNode[] {
  return projection.nodes.filter(
    (node) =>
      node.enabled &&
      (node.model !== undefined || node.light !== undefined || node.camera !== undefined),
  );
}
