/**
 * What hangs in a combatant's authored sockets.
 *
 * The renderer decides *where* — it knows which bone `right-hand-sword` names
 * and what local offset the Prefab authored. This file decides *what*, from the
 * combatant's authoritative Script state: the held archetype, the three armour
 * slots, the team marker and the team ring. Nothing here reads a Prefab id or a
 * clip; it reads game state and returns geometry.
 *
 * Every shape is rotationally symmetric about the bone's own axis on purpose.
 * A bone's "forward" is a rig convention, and a visor that assumed one would be
 * on the back of the head for a rig that chose the other; a band, a dome and a
 * skirt are right either way.
 */
import type { ReactNode } from "react";
import type { EquipmentSocketDefinition } from "@atc/schema";
import type { CombatantView } from "./state.ts";

const TEAM_COLOR = { ally: "#3f8cff", enemy: "#ff4d4d" } as const;
const TEAM_GLOW = { ally: "#0b3f8f", enemy: "#7a1414" } as const;

function Sword({ tint }: { tint: string }) {
  return (
    <group>
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.025, 0.03, 0.18, 8]} />
        <meshStandardMaterial color="#3b2412" />
      </mesh>
      <mesh position={[0, 0.12, 0]} castShadow>
        <boxGeometry args={[0.28, 0.035, 0.06]} />
        <meshStandardMaterial color={tint} metalness={0.6} roughness={0.3} />
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

function Shield({ tint }: { tint: string }) {
  return (
    <group rotation={[0, 0, Math.PI / 2]}>
      <mesh position={[0, 0.06, 0]} castShadow>
        <cylinderGeometry args={[0.33, 0.3, 0.07, 12]} />
        <meshStandardMaterial color={tint} metalness={0.35} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.11, 0]} castShadow>
        <cylinderGeometry args={[0.11, 0.11, 0.05, 10]} />
        <meshStandardMaterial color="#e2e8f0" metalness={0.8} roughness={0.25} />
      </mesh>
    </group>
  );
}

function Focus({ tint }: { tint: string }) {
  return (
    <group>
      <mesh position={[0, 0.12, 0]} castShadow>
        <cylinderGeometry args={[0.02, 0.02, 0.42, 6]} />
        <meshStandardMaterial color="#4c3a22" />
      </mesh>
      <mesh position={[0, 0.4, 0]}>
        <icosahedronGeometry args={[0.11, 0]} />
        <meshStandardMaterial color={tint} emissive={tint} emissiveIntensity={1.6} roughness={0.2} />
      </mesh>
    </group>
  );
}

function Blades({ tint }: { tint: string }) {
  return (
    <group>
      {[0, 1, 2].map((index) => (
        <mesh key={index} position={[0, 0.08 + index * 0.02, index * 0.035 - 0.035]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <coneGeometry args={[0.045, 0.24, 4]} />
          <meshStandardMaterial color={index === 1 ? tint : "#cbd5f5"} metalness={0.8} roughness={0.25} />
        </mesh>
      ))}
    </group>
  );
}

const HELMETS: Record<string, ReactNode> = {
  "scout-hood": (
    <group>
      <mesh position={[0, 0.06, 0]} castShadow>
        <sphereGeometry args={[0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI / 1.7]} />
        <meshStandardMaterial color="#4b5f43" roughness={0.95} side={2} />
      </mesh>
    </group>
  ),
  "iron-helm": (
    <group>
      <mesh position={[0, 0.07, 0]} castShadow>
        <sphereGeometry args={[0.145, 12, 8, 0, Math.PI * 2, 0, Math.PI / 1.9]} />
        <meshStandardMaterial color="#9aa3ad" metalness={0.75} roughness={0.35} side={2} />
      </mesh>
      <mesh position={[0, 0.155, 0]} castShadow>
        <cylinderGeometry args={[0.02, 0.035, 0.12, 6]} />
        <meshStandardMaterial color="#d1d5db" metalness={0.8} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.035, 0]} castShadow>
        <cylinderGeometry args={[0.152, 0.152, 0.035, 12]} />
        <meshStandardMaterial color="#6b7280" metalness={0.7} roughness={0.4} />
      </mesh>
    </group>
  ),
};

const CHESTS: Record<string, ReactNode> = {
  "leather-vest": (
    <mesh position={[0, 0.02, 0]} castShadow>
      <cylinderGeometry args={[0.2, 0.235, 0.34, 10, 1, true]} />
      <meshStandardMaterial color="#6b4426" roughness={0.9} side={2} />
    </mesh>
  ),
  "plated-cuirass": (
    <group>
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.215, 0.25, 0.38, 10, 1, true]} />
        <meshStandardMaterial color="#aab2bd" metalness={0.8} roughness={0.32} side={2} />
      </mesh>
      <mesh position={[0, 0.2, 0]} castShadow>
        <cylinderGeometry args={[0.245, 0.245, 0.06, 10]} />
        <meshStandardMaterial color="#7b8794" metalness={0.7} roughness={0.4} />
      </mesh>
    </group>
  ),
};

const LEGS: Record<string, ReactNode> = {
  "runner-greaves": (
    <mesh position={[0, -0.16, 0]} castShadow>
      <cylinderGeometry args={[0.19, 0.24, 0.26, 10, 1, true]} />
      <meshStandardMaterial color="#4f6b52" roughness={0.9} side={2} />
    </mesh>
  ),
  "iron-greaves": (
    <group>
      <mesh position={[0, -0.17, 0]} castShadow>
        <cylinderGeometry args={[0.205, 0.265, 0.3, 10, 1, true]} />
        <meshStandardMaterial color="#98a1ac" metalness={0.75} roughness={0.35} side={2} />
      </mesh>
      <mesh position={[0, -0.02, 0]} castShadow>
        <cylinderGeometry args={[0.2, 0.2, 0.055, 10]} />
        <meshStandardMaterial color="#6b7280" metalness={0.7} roughness={0.4} />
      </mesh>
    </group>
  ),
};

/**
 * The overhead team marker.
 *
 * A real 3D triangle rather than a screen overlay, so it is occluded by the
 * terrain and the trees like anything else, and emissive so it stays readable
 * once the sun goes down. It rides the *object*, not the head bone, which is
 * what keeps it level and above the character through every animation.
 */
function TeamMarker({ combatant }: { combatant: CombatantView }) {
  const color = TEAM_COLOR[combatant.team];
  const glow = TEAM_GLOW[combatant.team];
  const dim = !combatant.alive;
  return (
    <group>
      <mesh rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.22, 0.32, 3]} />
        <meshStandardMaterial
          color={dim ? "#5b6472" : color}
          emissive={dim ? "#20242c" : color}
          emissiveIntensity={dim ? 0.2 : 1.1}
          roughness={0.4}
        />
      </mesh>
      {combatant.protectionTicks > 0 && (
        <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -0.12, 0]}>
          <torusGeometry args={[0.3, 0.025, 6, 14]} />
          <meshStandardMaterial color="#ffffff" emissive={glow} emissiveIntensity={1.4} />
        </mesh>
      )}
    </group>
  );
}

function TeamRing({ combatant }: { combatant: CombatantView }) {
  const color = TEAM_COLOR[combatant.team];
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.42, 0.55, 18]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={combatant.alive ? 0.85 : 0.15}
        transparent
        opacity={combatant.alive ? 0.85 : 0.35}
        side={2}
      />
    </mesh>
  );
}

/**
 * Resolves one socket for one combatant.
 *
 * Returns `null` for a socket the current state leaves empty, which the
 * renderer treats as "draw nothing" — so an unequipped helmet slot is an absent
 * mesh rather than an invisible one, and repeated equips cannot stack.
 */
export function renderSkirmishAttachment(
  combatant: CombatantView | undefined,
  socket: EquipmentSocketDefinition,
): ReactNode {
  if (!combatant) return null;
  const tint = TEAM_COLOR[combatant.team];
  switch (socket.socketId) {
    case "right-hand-sword":
      if (combatant.loadoutId === "magic") return <Focus tint={tint} />;
      if (combatant.loadoutId === "throw") return <Blades tint={tint} />;
      return <Sword tint={tint} />;
    case "left-hand":
      return combatant.loadoutId === "shield" ? <Shield tint={tint} /> : null;
    case "head":
      return HELMETS[combatant.head] ?? null;
    case "chest":
      return CHESTS[combatant.chest] ?? null;
    case "pelvis":
      return LEGS[combatant.legs] ?? null;
    case "overhead":
      /* The player knows where they are; a marker over their own head is clutter. */
      return combatant.isPlayer ? null : <TeamMarker combatant={combatant} />;
    case "ground":
      return <TeamRing combatant={combatant} />;
    default:
      return null;
  }
}
