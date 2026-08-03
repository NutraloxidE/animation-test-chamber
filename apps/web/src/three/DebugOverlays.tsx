import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useChamber } from '../store.ts';
import type { ChamberEngine } from '../engine.ts';

const MAX_TRAIL = 240;

/**
 * Terrain and root-motion debugging (PLAN 11.4). Everything drawn here is a
 * value the simulation actually used this tick — ground normal, corrected foot
 * targets, pelvis offset and the travelled path — so the overlay can be trusted
 * to disagree with the animation when the animation is wrong.
 */
export function DebugOverlays({ engine }: { engine: ChamberEngine }) {
  // Terrain debug follows the terrain being *selected* now, not a tab being
  // open — the tab it used to watch no longer exists.
  const showDebug = useChamber((state) => state.sceneSelection.kind === 'terrain');

  const footL = useRef<THREE.Mesh>(null);
  const footR = useRef<THREE.Mesh>(null);
  const footLOriginal = useRef<THREE.Mesh>(null);
  const footROriginal = useRef<THREE.Mesh>(null);
  const normalArrow = useRef<THREE.ArrowHelper>(null);
  const trail = useRef<THREE.Line>(null);
  const trailPoints = useRef<number[]>([]);

  useFrame(() => {
    const state = engine.simulationState;

    // Root trajectory is always recorded so it is ready the moment it is shown.
    const points = trailPoints.current;
    const last = points.length;
    if (
      last === 0 ||
      Math.hypot(points[last - 3]! - state.position.x, points[last - 1]! - state.position.z) > 0.05
    ) {
      points.push(state.position.x, state.position.y + 0.05, state.position.z);
      if (points.length > MAX_TRAIL * 3) points.splice(0, 3);
      if (trail.current) {
        const geometry = trail.current.geometry as THREE.BufferGeometry;
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
        geometry.computeBoundingSphere();
      }
    }

    if (!showDebug) return;

    const ik = state.footIk;
    if (ik) {
      footL.current?.position.set(
        ik.left.correctedPosition.x,
        ik.left.correctedPosition.y,
        ik.left.correctedPosition.z,
      );
      footR.current?.position.set(
        ik.right.correctedPosition.x,
        ik.right.correctedPosition.y,
        ik.right.correctedPosition.z,
      );
      footLOriginal.current?.position.set(
        ik.left.originalPosition.x,
        ik.left.originalPosition.y,
        ik.left.originalPosition.z,
      );
      footROriginal.current?.position.set(
        ik.right.originalPosition.x,
        ik.right.originalPosition.y,
        ik.right.originalPosition.z,
      );
    }

    if (normalArrow.current) {
      const normal = state.terrain.normal;
      normalArrow.current.position.set(
        state.position.x,
        state.terrain.grounded ? state.terrain.groundHeight : state.position.y,
        state.position.z,
      );
      normalArrow.current.setDirection(new THREE.Vector3(normal.x, normal.y, normal.z).normalize());
    }
  });

  return (
    <group>
      <line ref={trail as never}>
        <bufferGeometry />
        <lineBasicMaterial color="#facc15" />
      </line>

      {showDebug && (
        <>
          {/* Corrected foot targets (solid) versus authored positions (wireframe). */}
          <mesh ref={footL}>
            <sphereGeometry args={[0.05, 12, 8]} />
            <meshBasicMaterial color="#22c55e" />
          </mesh>
          <mesh ref={footR}>
            <sphereGeometry args={[0.05, 12, 8]} />
            <meshBasicMaterial color="#ef4444" />
          </mesh>
          <mesh ref={footLOriginal}>
            <sphereGeometry args={[0.055, 10, 6]} />
            <meshBasicMaterial color="#22c55e" wireframe />
          </mesh>
          <mesh ref={footROriginal}>
            <sphereGeometry args={[0.055, 10, 6]} />
            <meshBasicMaterial color="#ef4444" wireframe />
          </mesh>

          <arrowHelper
            ref={normalArrow as never}
            args={[new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 1.2, 0x38bdf8, 0.25, 0.14]}
          />
        </>
      )}
    </group>
  );
}
