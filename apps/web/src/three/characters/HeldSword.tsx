export function HeldSword() {
  return (
    <group>
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.025, 0.03, 0.18, 8]} />
        <meshStandardMaterial color="#713f12" />
      </mesh>
      <mesh position={[0, 0.12, 0]} castShadow>
        <boxGeometry args={[0.28, 0.035, 0.06]} />
        <meshStandardMaterial color="#fbbf24" metalness={0.65} roughness={0.25} />
      </mesh>
      <mesh position={[0, 0.51, 0]} castShadow>
        <boxGeometry args={[0.075, 0.76, 0.025]} />
        <meshStandardMaterial color="#dbeafe" metalness={0.9} roughness={0.16} />
      </mesh>
      <mesh position={[0, 0.94, 0]} rotation={[0, 0, Math.PI / 4]} castShadow>
        <boxGeometry args={[0.075, 0.075, 0.025]} />
        <meshStandardMaterial color="#dbeafe" metalness={0.9} roughness={0.16} />
      </mesh>
    </group>
  );
}
