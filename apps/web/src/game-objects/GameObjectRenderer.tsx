/**
 * The production renderer (§3).
 *
 * It accepts a `RuntimeGameObject` — or the projection derived from one — and
 * nothing else. There is no `CharacterDefinition` prop, no Character id, no
 * entity kind, and no Prefab id used to choose a model: a Prefab id selecting
 * geometry would put the model decision back in the renderer, one rename away
 * from the Viewport and `/edit/prefab/<id>` disagreeing about who is on screen.
 *
 * Every decision this file makes is "which Three.js object expresses this
 * Component", and each one is independent of the others, so a node carrying a
 * model, an Animator, a motor and a light draws all four without a branch that
 * has to know that combination exists.
 *
 * Placement comes from `worldTransform`, already composed by the runtime. The
 * renderer never re-derives a world position from a parent chain — that would
 * be a second answer to where things are.
 */
import { Suspense } from 'react';
import { useGLTF } from '@react-three/drei';
import { clone as cloneSkinnedScene } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useMemo } from 'react';
import type { RuntimeGameObject } from '@atc/game-object-runtime';
import { AnimatedRepositoryModel } from './AnimatedRepositoryModel.tsx';
import {
  drawableNodes,
  projectGameObject,
  type GameObjectRenderNode,
  type GameObjectRenderProjection,
  type RenderProjectionIssue,
} from './render-projection.ts';

export interface GameObjectRendererProps {
  /** One running object, or a projection already derived from one. */
  gameObject?: RuntimeGameObject;
  projection?: GameObjectRenderProjection;
  selectedGameObjectId?: string | null;
  onSelect?: (gameObjectId: string) => void;
  /**
   * Reports a problem only the browser can see (§10.5).
   *
   * The projection catches everything knowable from documents alone — a state
   * whose motion set binds no take. What it cannot know is whether the GLTF on
   * disk actually contains the take the motion set named, because that needs
   * the file. Those arrive here, and the Scene Editor shows them beside the
   * resolver's own issues rather than leaving a mesh silently frozen.
   */
  onIssue?: (issue: RenderProjectionIssue) => void;
}

/**
 * An imported mesh.
 *
 * Cloned per node, because `useGLTF` caches per URL and two GameObjects sharing
 * one file must not share a skeleton — the same isolation rule the runtime
 * keeps for simulation state, applied to geometry.
 */
function RepositoryModel({ assetPath, castShadow, receiveShadow }: {
  assetPath: string;
  castShadow: boolean;
  receiveShadow: boolean;
}) {
  const gltf = useGLTF(assetPath);
  const scene = useMemo(() => cloneSkinnedScene(gltf.scene), [gltf.scene]);
  useMemo(() => {
    scene.traverse((child) => {
      child.castShadow = castShadow;
      child.receiveShadow = receiveShadow;
    });
  }, [scene, castShadow, receiveShadow]);
  return <primitive object={scene} />;
}

/**
 * A procedural body.
 *
 * The preset id names an *appearance*, and it arrived here from canonical
 * Prefab data through `ModelRendererComponent.model` — the renderer does not
 * look it up in a catalog keyed by Character id (§3).
 */
function ProceduralModel({ presetId, selected }: { presetId: string; selected: boolean }) {
  const color = PRESET_COLOR[presetId] ?? '#8fa3bf';
  return (
    <mesh position={[0, 0.9, 0]} castShadow>
      <capsuleGeometry args={[0.3, 1.2, 6, 16]} />
      <meshStandardMaterial
        color={color}
        emissive={selected ? '#facc15' : '#000000'}
        emissiveIntensity={selected ? 0.4 : 0}
      />
    </mesh>
  );
}

/** Appearance only. Never a model *choice* — the binding already made that. */
const PRESET_COLOR: Record<string, string> = {
  navigator: '#6ea8fe',
  relay: '#7fd7a8',
  sentinel: '#f0a6ca',
};

function NodeLight({ light }: { light: NonNullable<GameObjectRenderNode['light']> }) {
  if (light.lightType === 'directional') {
    return <directionalLight color={light.color} intensity={light.intensity} />;
  }
  if (light.lightType === 'spot') {
    return (
      <spotLight
        color={light.color}
        intensity={light.intensity}
        {...(light.range === undefined ? {} : { distance: light.range })}
        {...(light.spotAngleRad === undefined ? {} : { angle: light.spotAngleRad })}
      />
    );
  }
  return (
    <pointLight
      color={light.color}
      intensity={light.intensity}
      {...(light.range === undefined ? {} : { distance: light.range })}
    />
  );
}

/**
 * A camera node's gizmo.
 *
 * The Scene camera itself is driven by the host — a camera Component describes
 * a viewpoint, and two cameras both claiming the canvas is the one thing the
 * `activeCameraGameObjectId` resolution exists to prevent. What is drawn here
 * is only the marker that says a camera stands at this spot.
 */
function CameraGizmo({ selected }: { selected: boolean }) {
  return (
    <mesh rotation={[Math.PI / 2, 0, 0]}>
      <coneGeometry args={[0.22, 0.55, 4]} />
      <meshStandardMaterial
        color="#7fd7a8"
        emissive={selected ? '#facc15' : '#000000'}
        emissiveIntensity={selected ? 0.5 : 0}
      />
    </mesh>
  );
}

function RenderedNode({
  node,
  selected,
  onSelect,
  onIssue,
}: {
  node: GameObjectRenderNode;
  selected: boolean;
  onSelect?: (gameObjectId: string) => void;
  onIssue?: (issue: RenderProjectionIssue) => void;
}) {
  const { position, rotation, scale } = node.worldTransform;
  return (
    <group
      name={node.gameObjectId}
      position={[position.x, position.y, position.z]}
      quaternion={[rotation.x, rotation.y, rotation.z, rotation.w]}
      scale={[scale.x, scale.y, scale.z]}
      onClick={
        onSelect
          ? (event) => {
              // Only the front-most hit selects; otherwise a click passes
              // through and whatever is last in the list wins.
              event.stopPropagation();
              onSelect(node.gameObjectId);
            }
          : undefined
      }
    >
      {/*
        An imported model with an Animator is drawn by the animation adapter,
        and one without is drawn as static geometry. The branch is on the
        *Components present*, exactly like every other decision in this file —
        not on a kind, and not on whether the Prefab id looks like a character.
      */}
      {node.model?.binding.kind === 'repository-model' && node.animator && (
        <Suspense fallback={null}>
          <AnimatedRepositoryModel
            assetPath={node.model.binding.assetPath}
            castShadow={node.model.castShadow}
            receiveShadow={node.model.receiveShadow}
            animator={node.animator}
            gameObjectId={node.gameObjectId}
            displayName={node.displayName}
            {...(onIssue ? { onIssue } : {})}
          />
        </Suspense>
      )}
      {node.model?.binding.kind === 'repository-model' && !node.animator && (
        <Suspense fallback={null}>
          <RepositoryModel
            assetPath={node.model.binding.assetPath}
            castShadow={node.model.castShadow}
            receiveShadow={node.model.receiveShadow}
          />
        </Suspense>
      )}
      {/*
        A procedural body follows the runtime transform and has no skeletal
        clip to play — stated rather than hidden (§10.7). An Animator on such a
        node still resolves and still advances; it simply has no skinned mesh
        to pose, and marking this as evidence of skeletal playback would be a
        lie the harness could not catch.
      */}
      {node.model?.binding.kind === 'procedural-humanoid' && (
        <ProceduralModel presetId={node.model.binding.presetId} selected={selected} />
      )}
      {node.light && <NodeLight light={node.light} />}
      {node.camera && <CameraGizmo selected={selected} />}
    </group>
  );
}

/**
 * Draws one GameObject, including its child nodes.
 *
 * A projection carrying issues still draws what it can: an unrenderable node is
 * reported by the projection and skipped, and taking the whole Scene down for
 * one bad node would make an authoring mistake look like a crash.
 */
export function GameObjectRenderer({
  gameObject,
  projection,
  selectedGameObjectId,
  onSelect,
  onIssue,
}: GameObjectRendererProps): JSX.Element | null {
  const resolved = projection ?? (gameObject ? projectGameObject(gameObject) : undefined);
  if (!resolved) return null;
  return (
    <>
      {drawableNodes(resolved).map((node) => (
        <RenderedNode
          key={node.gameObjectId}
          node={node}
          /*
           * A child node counts as selected when its own instance is. Comparing
           * only the exact id would leave the whole body of a selected
           * character unhighlighted except for whichever node was clicked.
           */
          selected={
            selectedGameObjectId !== null &&
            selectedGameObjectId !== undefined &&
            (node.gameObjectId === selectedGameObjectId ||
              node.gameObjectId.startsWith(`${selectedGameObjectId}/`))
          }
          {...(onSelect ? { onSelect } : {})}
          {...(onIssue ? { onIssue } : {})}
        />
      ))}
    </>
  );
}
