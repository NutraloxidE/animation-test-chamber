/**
 * The in-canvas half of the game UI.
 *
 * Two jobs. It lights the world from the match clock — one in-game day per
 * match, morning through night and back to dawn — and it turns authoritative
 * combat events into things you can see at the place they happened: the damage
 * that was actually applied, the HP actually restored, a bark, a respawn
 * countdown.
 *
 * Feedback is driven from *sequence numbers* the Scripts bump when they change
 * state, never from a second hit test. If the number on screen is wrong, the
 * damage was wrong.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import {
  AnimatorRuntime,
  ModelRendererRuntime,
  type RuntimeScene,
} from "@atc/game-object-runtime";
import { publishCameraView } from "../game-session.ts";
import { playCue, rumble } from "./audio.ts";
import { PLAYER_ID, readSkirmish, type CombatantView, type SkirmishView } from "./state.ts";

/**
 * Sky, sun and fog for one point in the day.
 *
 * The stops line up with the director's own phase boundaries — morning, day,
 * evening, night, dawn — so the word in the HUD and the colour on screen change
 * together instead of drifting apart by a few seconds.
 */
interface SkyStop {
  at: number;
  sun: string;
  sunIntensity: number;
  sky: string;
  ground: string;
  hemi: number;
  ambient: number;
  fog: string;
  fogDensity: number;
}

const SKY: SkyStop[] = [
  { at: 0, sun: "#ffcf9c", sunIntensity: 1.1, sky: "#9dc2e6", ground: "#6b7f52", hemi: 0.5, ambient: 0.34, fog: "#c9dcec", fogDensity: 0.0055 },
  { at: 0.18, sun: "#fff4de", sunIntensity: 1.55, sky: "#bcdcff", ground: "#7d9160", hemi: 0.6, ambient: 0.42, fog: "#d6e7f5", fogDensity: 0.0032 },
  { at: 0.46, sun: "#ffb56b", sunIntensity: 1.2, sky: "#e8c39a", ground: "#75704f", hemi: 0.45, ambient: 0.3, fog: "#e6c096", fogDensity: 0.007 },
  { at: 0.62, sun: "#c97a54", sunIntensity: 0.55, sky: "#7c5f74", ground: "#3b3a47", hemi: 0.3, ambient: 0.16, fog: "#6a5470", fogDensity: 0.012 },
  /* Night: moonlit rather than black, because a match must stay playable. */
  { at: 0.75, sun: "#8ea6e8", sunIntensity: 0.3, sky: "#131d3a", ground: "#10182a", hemi: 0.3, ambient: 0.12, fog: "#101a33", fogDensity: 0.017 },
  { at: 0.88, sun: "#9db3ee", sunIntensity: 0.34, sky: "#1b2748", ground: "#141d31", hemi: 0.32, ambient: 0.13, fog: "#16223f", fogDensity: 0.015 },
  { at: 1, sun: "#ffc08a", sunIntensity: 1.05, sky: "#9dc2e6", ground: "#6b7f52", hemi: 0.5, ambient: 0.32, fog: "#c9dcec", fogDensity: 0.0055 },
];

function mixColor(a: string, b: string, t: number): string {
  return `#${new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString()}`;
}

function skyAt(progress: number): SkyStop {
  const clamped = Math.min(1, Math.max(0, progress));
  let lower = SKY[0]!;
  let upper = SKY[SKY.length - 1]!;
  for (let index = 0; index < SKY.length - 1; index += 1) {
    if (clamped >= SKY[index]!.at && clamped <= SKY[index + 1]!.at) {
      lower = SKY[index]!;
      upper = SKY[index + 1]!;
      break;
    }
  }
  const span = upper.at - lower.at || 1;
  const t = (clamped - lower.at) / span;
  return {
    at: clamped,
    sun: mixColor(lower.sun, upper.sun, t),
    sunIntensity: lower.sunIntensity + (upper.sunIntensity - lower.sunIntensity) * t,
    sky: mixColor(lower.sky, upper.sky, t),
    ground: mixColor(lower.ground, upper.ground, t),
    hemi: lower.hemi + (upper.hemi - lower.hemi) * t,
    ambient: lower.ambient + (upper.ambient - lower.ambient) * t,
    fog: mixColor(lower.fog, upper.fog, t),
    fogDensity: lower.fogDensity + (upper.fogDensity - lower.fogDensity) * t,
  };
}

interface FloatItem {
  key: number;
  kind: "damage" | "player-damage" | "heal" | "reward" | "bark";
  text: string;
  x: number;
  y: number;
  z: number;
  offsetX: number;
  life: number;
  maxLife: number;
}

const MAX_FLOATS = 14;

export function SkirmishWorldLayer({ runtime }: { runtime: RuntimeScene }): JSX.Element {
  const { camera, scene } = useThree();
  const [sky, setSky] = useState(() => skyAt(0));
  const [floats, setFloats] = useState<FloatItem[]>([]);
  const [countdowns, setCountdowns] = useState<{ id: string; seconds: number; x: number; y: number; z: number; team: string }[]>([]);
  const sequences = useRef(new Map<string, { hit: number; heal: number; bark: number }>());
  const rewardSeq = useRef(-1);
  const alive = useRef(new Map<string, boolean>());
  const level = useRef(1);
  const matchState = useRef("active");
  const feedback = useRef(-1);
  const nextKey = useRef(1);
  const frame = useRef(0);
  const pending = useRef<FloatItem[]>([]);

  /*
   * Warm every file the Scene will need before the first swing needs it.
   *
   * Derived from the Scene's own Components rather than a hand-written list, so
   * a Prefab that starts using another animation library is preloaded without
   * anybody remembering to add it here. A file that fails to warm is left to
   * the renderer's own Suspense boundary; the match still starts.
   */
  useEffect(() => {
    const files = new Set<string>();
    for (const root of runtime.gameObjects)
      for (const object of root.walk())
        for (const component of object.components) {
          if (component instanceof ModelRendererRuntime && component.model.kind === "repository-model")
            files.add(component.model.assetPath);
          if (component instanceof AnimatorRuntime)
            for (const file of component.playback.sourceFiles) files.add(file);
        }
    for (const file of files) {
      try {
        useGLTF.preload(file);
      } catch {
        /* A cosmetic asset that will not warm must not stop the match. */
      }
    }
  }, [runtime]);

  /*
   * The sun aims at the arena centre through a target object, and that object
   * is removed with the layer — a light target left behind is a small leak, but
   * it is the kind that accumulates once per Scene change.
   */
  const sunTarget = useMemo(() => new THREE.Object3D(), []);
  useEffect(() => {
    sunTarget.position.set(0, 0, 0);
    scene.add(sunTarget);
    return () => {
      scene.remove(sunTarget);
    };
  }, [scene, sunTarget]);

  useFrame((_, delta) => {
    /* The compass and the threat arrows read this; both live in the DOM HUD. */
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    publishCameraView({ yawRad: euler.y, x: camera.position.x, y: camera.position.y, z: camera.position.z });

    frame.current += 1;
    if (frame.current % 3 === 0) {
      const view = readSkirmish(runtime);
      if (view) collect(view);
    }

    /* Ageing is presentation-only, so it uses render delta rather than ticks. */
    let changed = pending.current.length > 0;
    const next: FloatItem[] = [];
    for (const item of floats) {
      const life = item.life - delta;
      if (life <= 0) {
        changed = true;
        continue;
      }
      next.push({ ...item, life });
    }
    if (changed) {
      const merged = [...next, ...pending.current];
      pending.current = [];
      setFloats(merged.slice(Math.max(0, merged.length - MAX_FLOATS)));
    } else if (next.length === floats.length && next.length > 0) {
      setFloats(next);
    }
  });

  function collect(view: SkirmishView): void {
    const player = view.player;
    const playerPosition = player?.position;
    for (const combatant of view.combatants) {
      const previous = sequences.current.get(combatant.id) ?? { hit: combatant.hitSeq, heal: combatant.healSeq, bark: combatant.barkSeq };
      const distance = playerPosition
        ? Math.hypot(combatant.position.x - playerPosition.x, combatant.position.z - playerPosition.z)
        : 0;

      if (combatant.hitSeq !== previous.hit && combatant.hitAmount > 0) {
        /*
         * Priority, so a brawl across the valley cannot bury the hit that just
         * landed on the player: the player's own damage always shows, nearby
         * combat shows, and distant NPC-versus-NPC trading is dropped.
         */
        const relevant = combatant.isPlayer || combatant.id === player?.targetId || distance < 26;
        if (combatant.isPlayer) {
          playCue("player-hit");
          rumble(90, 0.7, 0.35);
        } else if (distance < 20) playCue("hit", Math.max(0.25, 1 - distance / 20));
        if (relevant) {
          push({
            kind: combatant.isPlayer ? "player-damage" : "damage",
            text: `${Math.round(combatant.hitAmount)}`,
            x: combatant.position.x,
            y: combatant.position.y + 1.7,
            z: combatant.position.z,
            life: 0.95,
          });
        }
      }
      if (combatant.healSeq !== previous.heal && combatant.healAmount > 0) {
        if (combatant.isPlayer) playCue("heal");
        push({
          kind: "heal",
          text: `+${Math.round(combatant.healAmount)}`,
          x: combatant.position.x,
          y: combatant.position.y + 1.9,
          z: combatant.position.z,
          life: 1.1,
        });
      }
      if (combatant.barkSeq !== previous.bark && combatant.barkText !== "" && distance < 30) {
        push({
          kind: "bark",
          text: combatant.barkText,
          x: combatant.position.x,
          y: combatant.position.y + 2.5,
          z: combatant.position.z,
          life: 2.2,
        });
      }
      const wasAlive = alive.current.get(combatant.id);
      if (wasAlive === true && !combatant.alive) playCue("ko", distance < 24 ? 1 : 0.4);
      alive.current.set(combatant.id, combatant.alive);
      sequences.current.set(combatant.id, { hit: combatant.hitSeq, heal: combatant.healSeq, bark: combatant.barkSeq });
    }

    if (rewardSeq.current < 0) rewardSeq.current = view.director.pickupSeq;
    else if (view.director.pickupSeq !== rewardSeq.current) {
      rewardSeq.current = view.director.pickupSeq;
      playCue("pickup");
      if (playerPosition)
        push({
          kind: "reward",
          text: `+${view.director.lastPickupValue} scrip`,
          x: playerPosition.x,
          y: playerPosition.y + 2.2,
          z: playerPosition.z,
          life: 1.2,
        });
    }

    /* One cue per transition, driven by authoritative state rather than a timer. */
    if (view.director.level !== level.current) {
      if (view.director.level > level.current) playCue("level");
      level.current = view.director.level;
    }
    if (view.director.matchState !== matchState.current) {
      if (view.director.matchState === "ending") playCue("result");
      else if (view.director.matchState === "active") playCue("match-start");
      matchState.current = view.director.matchState;
    }
    if (view.director.feedbackSeq !== feedback.current) {
      if (feedback.current >= 0) playCue("purchase");
      feedback.current = view.director.feedbackSeq;
    }

    setSky(skyAt(view.dayProgress));
    const downed = view.combatants
      .filter((combatant) => !combatant.alive)
      .map((combatant) => ({
        id: combatant.id,
        seconds: Math.max(0, Math.ceil(combatant.downTicks / 60)),
        x: combatant.position.x,
        y: combatant.position.y + 2.3,
        z: combatant.position.z,
        team: combatant.team,
      }));
    setCountdowns((current) =>
      current.length === downed.length && current.every((entry, index) => entry.id === downed[index]?.id && entry.seconds === downed[index]?.seconds)
        ? current
        : downed,
    );
  }

  function push(item: Omit<FloatItem, "key" | "offsetX" | "maxLife">): void {
    nextKey.current += 1;
    /* Rapid hits fan out laterally so two numbers never sit on top of each other. */
    pending.current.push({
      ...item,
      key: nextKey.current,
      offsetX: ((nextKey.current % 3) - 1) * 26,
      maxLife: item.life,
    });
  }

  const sunAngle = sky.at * Math.PI * 2 - Math.PI / 2;
  const sunHeight = Math.max(0.12, Math.sin(sunAngle * 0.5 + 0.35));

  /*
   * A fragment, not a group: `background` and `fog` attach to the *parent*
   * object, and the parent of this layer is the Scene itself. Wrapping them in
   * a group would quietly attach a sky to a group nobody renders.
   */
  return (
    <>
      <fogExp2 attach="fog" args={[sky.fog, sky.fogDensity]} />
      <color attach="background" args={[sky.sky]} />
      <hemisphereLight args={[sky.sky, sky.ground, sky.hemi]} />
      <ambientLight color={sky.sky} intensity={sky.ambient} />
      <directionalLight
        color={sky.sun}
        intensity={sky.sunIntensity}
        position={[Math.cos(sunAngle) * 60, 20 + sunHeight * 50, Math.sin(sunAngle) * 60]}
        target={sunTarget}
      />
      {floats.map((item) => (
        <group key={item.key} position={[item.x, item.y + (1 - item.life / item.maxLife) * 1.1, item.z]}>
          <Html center zIndexRange={[20, 0]} style={{ pointerEvents: "none", transform: `translateX(${item.offsetX}px)` }}>
            <span className={`skirmish-float skirmish-float--${item.kind}`} style={{ opacity: Math.min(1, item.life * 2.2) }}>
              {item.text}
            </span>
          </Html>
        </group>
      ))}
      {countdowns.map((entry) => (
        <group key={entry.id} position={[entry.x, entry.y, entry.z]}>
          <Html center zIndexRange={[19, 0]} style={{ pointerEvents: "none" }}>
            <span className={`skirmish-countdown skirmish-countdown--${entry.team}`}>{entry.seconds}</span>
          </Html>
        </group>
      ))}
    </>
  );
}

/** Whether a combatant is currently drawn as downed. Exported for the HUD. */
export function isDowned(combatant: CombatantView | undefined): boolean {
  return combatant !== undefined && !combatant.alive;
}

export { PLAYER_ID };
