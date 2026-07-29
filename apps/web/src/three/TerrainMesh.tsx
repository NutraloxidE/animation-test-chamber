import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { TerrainFeature, TerrainPreset } from '@atc/schema';
import { movingPlatformOffset } from '@atc/terrain-runtime';
import type { ChamberEngine } from '../engine.ts';

const SURFACE_COLORS: Record<string, string> = {
  default: '#334155',
  ice: '#93c5fd',
  mud: '#78350f',
  grip: '#166534',
};

function colorFor(surface: string): string {
  return SURFACE_COLORS[surface] ?? '#334155';
}

/** Builds a triangulated ramp matching the analytic slope the simulation samples. */
function SlopeMesh({ feature }: { feature: Extract<TerrainFeature, { kind: 'slope' }> }) {
  const geometry = useMemo(() => {
    const width = 24;
    const { startZ, endZ, rise } = feature;
    const positions = new Float32Array([
      // Flat run before the ramp.
      -width / 2, 0, startZ - 20, width / 2, 0, startZ - 20, width / 2, 0, startZ,
      -width / 2, 0, startZ - 20, width / 2, 0, startZ, -width / 2, 0, startZ,
      // The ramp itself.
      -width / 2, 0, startZ, width / 2, 0, startZ, width / 2, rise, endZ,
      -width / 2, 0, startZ, width / 2, rise, endZ, -width / 2, rise, endZ,
      // Flat plateau after it.
      -width / 2, rise, endZ, width / 2, rise, endZ, width / 2, rise, endZ + 20,
      -width / 2, rise, endZ, width / 2, rise, endZ + 20, -width / 2, rise, endZ + 20,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    return geo;
  }, [feature]);

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial color={colorFor(feature.surface)} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Displaced plane matching the analytic noise field used for ground sampling. */
function UnevenMesh({ feature }: { feature: Extract<TerrainFeature, { kind: 'uneven' }> }) {
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(40, 40, 80, 80);
    geo.rotateX(-Math.PI / 2);
    const position = geo.getAttribute('position');
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const z = position.getZ(i);
      position.setY(
        i,
        feature.amplitude * Math.sin(feature.frequencyX * x) * Math.cos(feature.frequencyZ * z),
      );
    }
    geo.computeVertexNormals();
    return geo;
  }, [feature]);

  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial color={colorFor(feature.surface)} />
    </mesh>
  );
}

function MovingPlatformMesh({
  feature,
  engine,
}: {
  feature: Extract<TerrainFeature, { kind: 'moving-platform' }>;
  engine: ChamberEngine;
}) {
  const mesh = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (!mesh.current) return;
    // Driven by simulation time, not render time, so the visual and the collision
    // sample can never disagree.
    const timeSec = engine.simulationState.timeSec;
    const offset = movingPlatformOffset(feature, timeSec);
    mesh.current.position.set(
      feature.center.x + (feature.axis === 'x' ? offset : 0),
      feature.center.y + (feature.axis === 'y' ? offset : 0),
      feature.center.z + (feature.axis === 'z' ? offset : 0),
    );
    mesh.current.rotation.y = feature.angularVelocity * timeSec;
  });

  return (
    <mesh ref={mesh} receiveShadow castShadow>
      <boxGeometry args={[feature.size.x, feature.size.y, feature.size.z]} />
      <meshStandardMaterial color="#0ea5e9" />
    </mesh>
  );
}

function FeatureMesh({ feature, engine }: { feature: TerrainFeature; engine: ChamberEngine }) {
  switch (feature.kind) {
    case 'plane':
      return (
        <mesh position={[0, feature.height - 0.05, 0]} receiveShadow>
          <boxGeometry args={[80, 0.1, 80]} />
          <meshStandardMaterial color={colorFor(feature.surface)} />
        </mesh>
      );

    case 'slope':
      return <SlopeMesh feature={feature} />;

    case 'steps': {
      const topHeight = feature.count * feature.stepHeight;
      const endZ = feature.startZ + feature.count * feature.stepDepth;
      const landingDepth = 24;
      return (
        <group>
          {Array.from({ length: feature.count }, (_, index) => {
            const step = index + 1;
            return (
              <mesh
                key={index}
                position={[
                  0,
                  (step * feature.stepHeight) / 2,
                  feature.startZ + index * feature.stepDepth + feature.stepDepth / 2,
                ]}
                receiveShadow
                castShadow
              >
                <boxGeometry args={[8, step * feature.stepHeight, feature.stepDepth]} />
                <meshStandardMaterial color={colorFor(feature.surface)} />
              </mesh>
            );
          })}
          {/*
            The ground sampler keeps returning the top height past the last
            step, so a landing must be drawn to match. Without it the character
            walks convincingly on nothing.
          */}
          <mesh position={[0, topHeight / 2, endZ + landingDepth / 2]} receiveShadow castShadow>
            <boxGeometry args={[8, topHeight, landingDepth]} />
            <meshStandardMaterial color={colorFor(feature.surface)} />
          </mesh>
        </group>
      );
    }

    case 'box':
      return (
        <mesh
          position={[feature.center.x, feature.center.y, feature.center.z]}
          receiveShadow
          castShadow
        >
          <boxGeometry args={[feature.size.x, feature.size.y, feature.size.z]} />
          <meshStandardMaterial color={colorFor(feature.surface)} />
        </mesh>
      );

    case 'ledge':
      return (
        <mesh position={[0, feature.height - 0.05, feature.edgeZ - 20]} receiveShadow>
          <boxGeometry args={[40, 0.1, 40]} />
          <meshStandardMaterial color={colorFor(feature.surface)} />
        </mesh>
      );

    case 'moving-platform':
      return <MovingPlatformMesh feature={feature} engine={engine} />;

    case 'uneven':
      return <UnevenMesh feature={feature} />;
  }
}

/**
 * Renders the terrain directly from the canonical preset, so what is drawn and
 * what the character collides against come from one description.
 */
export function TerrainMesh({ preset, engine }: { preset: TerrainPreset; engine: ChamberEngine }) {
  return (
    <group>
      {preset.features.map((feature, index) => (
        <FeatureMesh key={`${feature.kind}-${index}`} feature={feature} engine={engine} />
      ))}
      <gridHelper args={[80, 80, '#1e293b', '#1e293b']} position={[0, 0.02, 0]} />
    </group>
  );
}
