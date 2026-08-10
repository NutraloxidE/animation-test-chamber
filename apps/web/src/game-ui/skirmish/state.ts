/**
 * The HUD's read model.
 *
 * Every value the interface shows is projected from the authoritative Gameplay
 * Script state on the running Scene — there is no second copy of HP, no shadow
 * currency counter, and no UI-side combat maths. When a number here is wrong,
 * the game is wrong, which is the only arrangement in which the HUD is evidence
 * of anything.
 */
import type { RuntimeScene } from "@atc/game-object-runtime";

export const DIRECTOR_ID = "match-director";
export const PLAYER_ID = "skirmish-player";

export interface LoadoutInfo {
  id: string;
  label: string;
  short: string;
}

/** Mirrors the Script's authored archetypes, for labels only. */
export const LOADOUTS: LoadoutInfo[] = [
  { id: "sword", label: "Longsword", short: "SWD" },
  { id: "shield", label: "Sword & Shield", short: "SHD" },
  { id: "magic", label: "Ember Focus", short: "MAG" },
  { id: "throw", label: "Throwing Blades", short: "THR" },
];

export interface ShopEntry {
  id: string;
  label: string;
  price: number;
  slot: "consumable" | "head" | "chest" | "legs";
  effect: string;
}

/** Presentation copy for what the director sells. Prices come from the Script. */
export const SHOP_CATALOG: ShopEntry[] = [
  { id: "field-ration", label: "Field Ration", price: 18, slot: "consumable", effect: "Restores 45 HP" },
  { id: "scout-hood", label: "Scout Hood", price: 30, slot: "head", effect: "DEF +2 · STA +4" },
  { id: "iron-helm", label: "Iron Helm", price: 55, slot: "head", effect: "HP +8 · DEF +4 · STA −4" },
  { id: "leather-vest", label: "Leather Vest", price: 40, slot: "chest", effect: "HP +10 · DEF +3" },
  { id: "plated-cuirass", label: "Plated Cuirass", price: 75, slot: "chest", effect: "HP +22 · DEF +7 · STA −8" },
  { id: "runner-greaves", label: "Runner Greaves", price: 35, slot: "legs", effect: "DEF +1 · STA +14" },
  { id: "iron-greaves", label: "Iron Greaves", price: 60, slot: "legs", effect: "HP +6 · DEF +4 · STA −2" },
];

export const ITEM_LABELS: Record<string, string> = Object.fromEntries(
  SHOP_CATALOG.map((entry) => [entry.id, entry.label]),
);

export interface CombatantView {
  id: string;
  team: "ally" | "enemy";
  isPlayer: boolean;
  alive: boolean;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  attack: number;
  defense: number;
  loadout: number;
  loadoutId: string;
  head: string;
  chest: string;
  legs: string;
  downTicks: number;
  protectionTicks: number;
  hitSeq: number;
  hitAmount: number;
  healSeq: number;
  healAmount: number;
  barkSeq: number;
  barkText: string;
  aiState: string;
  targetId: string;
  threat: boolean;
  upHp: number;
  upStamina: number;
  upAttack: number;
  upDefense: number;
  position: { x: number; y: number; z: number };
}

export interface DirectorView {
  generation: number;
  matchState: string;
  day: number;
  matchTicks: number;
  matchDurationTicks: number;
  bannerTicks: number;
  phase: string;
  allyScore: number;
  enemyScore: number;
  playerKos: number;
  playerAssists: number;
  playerDeaths: number;
  xp: number;
  level: number;
  xpToNext: number;
  pendingLevelUps: number;
  currency: number;
  currencyEarned: number;
  potions: number;
  upHp: number;
  upStamina: number;
  upAttack: number;
  upDefense: number;
  owned: string[];
  equippedHead: string;
  equippedChest: string;
  equippedLegs: string;
  pickupSeq: number;
  lastPickupValue: number;
  pickupCount: number;
  feedbackSeq: number;
  feedbackText: string;
  result: string;
  aliveAllies: number;
  aliveEnemies: number;
  log: { tick: number; kind: string; text: string }[];
}

export interface SkirmishView {
  director: DirectorView;
  player: CombatantView | undefined;
  combatants: CombatantView[];
  /** Progress through the day, in [0, 1]. Drives the sky and the clock. */
  dayProgress: number;
}

function number(source: Record<string, unknown> | undefined, key: string, fallback = 0): number {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(source: Record<string, unknown> | undefined, key: string, fallback = ""): string {
  const value = source?.[key];
  return typeof value === "string" ? value : fallback;
}

function flag(source: Record<string, unknown> | undefined, key: string): boolean {
  return source?.[key] === true;
}

/** True when this Scene is a Wildlands match. Nothing else mounts the HUD. */
export function hasSkirmish(runtime: RuntimeScene | null): boolean {
  return runtime?.get(DIRECTOR_ID) !== undefined;
}

export function readSkirmish(runtime: RuntimeScene): SkirmishView | null {
  const snapshot = runtime.gameplaySnapshot();
  const directorState = snapshot[DIRECTOR_ID]?.["director"] as Record<string, unknown> | undefined;
  if (!directorState) return null;

  const combatants: CombatantView[] = [];
  for (const [gameObjectId, components] of Object.entries(snapshot)) {
    const state = components["combatant"] as Record<string, unknown> | undefined;
    if (!state) continue;
    const node = runtime.get(gameObjectId);
    const position = node?.worldTransform.position ?? { x: 0, y: 0, z: 0 };
    combatants.push({
      id: gameObjectId,
      team: text(state, "team") === "enemy" ? "enemy" : "ally",
      isPlayer: gameObjectId === PLAYER_ID,
      alive: flag(state, "alive"),
      hp: number(state, "hp"),
      maxHp: Math.max(1, number(state, "maxHp", 1)),
      stamina: number(state, "stamina"),
      maxStamina: Math.max(1, number(state, "maxStamina", 1)),
      attack: number(state, "attack"),
      defense: number(state, "defense"),
      loadout: number(state, "loadout"),
      loadoutId: text(state, "loadoutId", "sword"),
      head: text(state, "head"),
      chest: text(state, "chest"),
      legs: text(state, "legs"),
      downTicks: number(state, "downTicks"),
      protectionTicks: number(state, "protectionTicks"),
      hitSeq: number(state, "hitSeq"),
      hitAmount: number(state, "hitAmount"),
      healSeq: number(state, "healSeq"),
      healAmount: number(state, "healAmount"),
      barkSeq: number(state, "barkSeq"),
      barkText: text(state, "barkText"),
      aiState: text(state, "aiState"),
      targetId: text(state, "targetId"),
      threat: flag(state, "threat"),
      upHp: number(state, "upHp"),
      upStamina: number(state, "upStamina"),
      upAttack: number(state, "upAttack"),
      upDefense: number(state, "upDefense"),
      position: { ...position },
    });
  }

  const durationTicks = Math.max(1, number(directorState, "matchDurationTicks", 1));
  const director: DirectorView = {
    generation: number(directorState, "generation"),
    matchState: text(directorState, "matchState", "active"),
    day: number(directorState, "day", 1),
    matchTicks: number(directorState, "matchTicks"),
    matchDurationTicks: durationTicks,
    bannerTicks: number(directorState, "bannerTicks"),
    phase: text(directorState, "phase", "morning"),
    allyScore: number(directorState, "allyScore"),
    enemyScore: number(directorState, "enemyScore"),
    playerKos: number(directorState, "playerKos"),
    playerAssists: number(directorState, "playerAssists"),
    playerDeaths: number(directorState, "playerDeaths"),
    xp: number(directorState, "xp"),
    level: number(directorState, "level", 1),
    xpToNext: Math.max(1, number(directorState, "xpToNext", 1)),
    pendingLevelUps: number(directorState, "pendingLevelUps"),
    currency: number(directorState, "currency"),
    currencyEarned: number(directorState, "currencyEarned"),
    potions: number(directorState, "potions"),
    upHp: number(directorState, "upHp"),
    upStamina: number(directorState, "upStamina"),
    upAttack: number(directorState, "upAttack"),
    upDefense: number(directorState, "upDefense"),
    owned: Array.isArray(directorState["owned"]) ? (directorState["owned"] as string[]) : [],
    equippedHead: text(directorState, "equippedHead"),
    equippedChest: text(directorState, "equippedChest"),
    equippedLegs: text(directorState, "equippedLegs"),
    pickupSeq: number(directorState, "pickupSeq"),
    lastPickupValue: number(directorState, "lastPickupValue"),
    pickupCount: Array.isArray(directorState["pickups"]) ? (directorState["pickups"] as unknown[]).length : 0,
    feedbackSeq: number(directorState, "feedbackSeq"),
    feedbackText: text(directorState, "feedbackText"),
    result: text(directorState, "result"),
    aliveAllies: number(directorState, "aliveAllies"),
    aliveEnemies: number(directorState, "aliveEnemies"),
    log: Array.isArray(directorState["log"]) ? (directorState["log"] as DirectorView["log"]) : [],
  };

  return {
    director,
    player: combatants.find((combatant) => combatant.isPlayer),
    combatants,
    dayProgress: Math.min(1, director.matchTicks / durationTicks),
  };
}

/** Cardinal label for a yaw, for the compass strip. */
export const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

export function headingLabel(yawRad: number): string {
  const normalized = ((yawRad % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const index = Math.round(normalized / (Math.PI / 4)) % 8;
  return COMPASS_POINTS[index] ?? "N";
}
