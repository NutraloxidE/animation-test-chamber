/**
 * Wildlands Skirmish — the match director.
 *
 * One object owns everything that is true of the *match* rather than of a
 * fighter: the day clock, the team score, the lifecycle, the player's
 * match-scoped progression, the currency on the ground, and the bounded debug
 * log. Combatants report to it and it answers with events; nothing here reaches
 * into another script's state.
 *
 * The load-bearing idea is the **generation**. Every deferred thing — a queued
 * coin, a KO report in flight, an open level-up prompt — carries the generation
 * of the match that created it, and anything arriving from an older generation
 * is dropped. That is what makes "the previous match's reward appeared in the
 * next one" unrepresentable rather than merely unlikely.
 */
import {
  booleanProp,
  defineGameplayScript,
  numberProp,
  stringProp,
  type GameplayContext,
} from '@atc/gameplay-sdk';

/** What the shop sells. Prices and effects are authored here, once. */
const SHOP: Record<string, { price: number; kind: 'consumable' | 'armor'; slot: string; label: string }> = {
  'field-ration': { price: 18, kind: 'consumable', slot: 'consumable', label: 'Field Ration' },
  'scout-hood': { price: 30, kind: 'armor', slot: 'head', label: 'Scout Hood' },
  'iron-helm': { price: 55, kind: 'armor', slot: 'head', label: 'Iron Helm' },
  'leather-vest': { price: 40, kind: 'armor', slot: 'chest', label: 'Leather Vest' },
  'plated-cuirass': { price: 75, kind: 'armor', slot: 'chest', label: 'Plated Cuirass' },
  'runner-greaves': { price: 35, kind: 'armor', slot: 'legs', label: 'Runner Greaves' },
  'iron-greaves': { price: 60, kind: 'armor', slot: 'legs', label: 'Iron Greaves' },
};

const UPGRADE_STATS = ['hp', 'stamina', 'attack', 'defense'] as const;
type UpgradeStat = (typeof UPGRADE_STATS)[number];

type MatchState = 'active' | 'ending' | 'resetting';

type DirectorProps = {
  playerId: string;
  matchSeconds: number;
  endingSeconds: number;
  bannerSeconds: number;
  koXp: number;
  assistXp: number;
  koCurrency: number;
  potionHeal: number;
  startingPotions: number;
  pickupLifetimeSeconds: number;
  pickupRadius: number;
  pickupPrefabId: string;
  pickupPrefabVersion: string;
  pickupPrefabHash: string;
  debugEnabled: boolean;
};

type LogEntry = { tick: number; kind: string; text: string };
type Pickup = { id: string; x: number; z: number; ticks: number; value: number };

type DirectorState = {
  generation: number;
  matchState: MatchState;
  day: number;
  matchTicks: number;
  matchDurationTicks: number;
  endingTicks: number;
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
  pickups: Pickup[];
  pickupSeq: number;
  pickupSerial: number;
  lastPickupValue: number;
  feedbackSeq: number;
  feedbackText: string;
  result: string;
  aliveAllies: number;
  aliveEnemies: number;
  warnings: string[];
  log: LogEntry[];
  nightAnnounced: boolean;
};

function xpForLevel(level: number): number {
  return 70 + (level - 1) * 50;
}

/** Morning → day → evening → night → dawn, over exactly one match. */
function phaseOf(progress: number): string {
  if (progress < 0.18) return 'morning';
  if (progress < 0.46) return 'day';
  if (progress < 0.62) return 'evening';
  if (progress < 0.88) return 'night';
  return 'dawn';
}

interface ScriptSelf {
  readonly gameObjectId: string;
  readonly props: DirectorProps;
  readonly state: DirectorState;
}

function log(self: ScriptSelf, tick: number, kind: string, text: string): void {
  self.state.log.push({ tick, kind, text });
  /* Bounded on purpose: a debug aid that grows forever is a leak with a name. */
  if (self.state.log.length > 60) self.state.log.splice(0, self.state.log.length - 60);
}

function feedback(self: ScriptSelf, text: string): void {
  self.state.feedbackText = text;
  self.state.feedbackSeq += 1;
}

function combatants(ctx: GameplayContext) {
  return ctx.world.findByTag('skirmish-combatant');
}

/** Clears every coin this match put on the ground. */
function clearPickups(ctx: GameplayContext, self: ScriptSelf): void {
  for (const pickup of self.state.pickups) ctx.world.despawn(pickup.id);
  self.state.pickups = [];
}

function startMatch(ctx: GameplayContext, self: ScriptSelf, nextDay: boolean): void {
  self.state.generation += 1;
  if (nextDay) self.state.day += 1;
  self.state.matchState = 'active';
  self.state.matchTicks = 0;
  self.state.endingTicks = 0;
  self.state.bannerTicks = Math.round(self.props.bannerSeconds / ctx.deltaSeconds);
  self.state.phase = 'morning';
  self.state.allyScore = 0;
  self.state.enemyScore = 0;
  self.state.playerKos = 0;
  self.state.playerAssists = 0;
  self.state.playerDeaths = 0;
  self.state.xp = 0;
  self.state.level = 1;
  self.state.xpToNext = xpForLevel(1);
  self.state.pendingLevelUps = 0;
  self.state.currency = 0;
  self.state.currencyEarned = 0;
  self.state.potions = self.props.startingPotions;
  self.state.upHp = 0;
  self.state.upStamina = 0;
  self.state.upAttack = 0;
  self.state.upDefense = 0;
  self.state.owned = [];
  self.state.equippedHead = '';
  self.state.equippedChest = '';
  self.state.equippedLegs = '';
  self.state.result = '';
  self.state.nightAnnounced = false;
  clearPickups(ctx, self);
  for (const combatant of combatants(ctx))
    ctx.world.emit(combatant.id, { type: 'configure', payload: { generation: self.state.generation, active: true } });
  log(self, ctx.tick, 'MatchStart', `Day ${self.state.day} — 5 vs 5`);
}

export default defineGameplayScript({
  id: 'skirmish-director',
  version: '1.0.0',
  displayName: 'Skirmish Match Director',
  properties: {
    playerId: stringProp({ default: 'skirmish-player', instanceOverride: true }),
    matchSeconds: numberProp({ default: 300, min: 10, instanceOverride: true }),
    endingSeconds: numberProp({ default: 7, min: 1, instanceOverride: true }),
    bannerSeconds: numberProp({ default: 2.6, min: 0, instanceOverride: true }),
    koXp: numberProp({ default: 40, min: 0, instanceOverride: true }),
    assistXp: numberProp({ default: 15, min: 0, instanceOverride: true }),
    koCurrency: numberProp({ default: 14, min: 0, instanceOverride: true }),
    potionHeal: numberProp({ default: 45, min: 1, instanceOverride: true }),
    startingPotions: numberProp({ default: 1, min: 0, instanceOverride: true }),
    pickupLifetimeSeconds: numberProp({ default: 26, min: 1, instanceOverride: true }),
    pickupRadius: numberProp({ default: 2.4, min: 0.2, instanceOverride: true }),
    pickupPrefabId: stringProp({ default: 'wildlands-coin', instanceOverride: true }),
    pickupPrefabVersion: stringProp({ default: '1.0.0', instanceOverride: true }),
    pickupPrefabHash: stringProp({ default: '', instanceOverride: true }),
    debugEnabled: booleanProp({ default: false, instanceOverride: true }),
  },
  state: ({ props }): DirectorState => ({
    generation: 0,
    matchState: 'active' as MatchState,
    day: 1,
    matchTicks: 0,
    matchDurationTicks: Math.round(props.matchSeconds * 60),
    endingTicks: 0,
    bannerTicks: 0,
    phase: 'morning',
    allyScore: 0,
    enemyScore: 0,
    playerKos: 0,
    playerAssists: 0,
    playerDeaths: 0,
    xp: 0,
    level: 1,
    xpToNext: xpForLevel(1),
    pendingLevelUps: 0,
    currency: 0,
    currencyEarned: 0,
    potions: props.startingPotions,
    upHp: 0,
    upStamina: 0,
    upAttack: 0,
    upDefense: 0,
    owned: [] as string[],
    equippedHead: '',
    equippedChest: '',
    equippedLegs: '',
    pickups: [] as Pickup[],
    pickupSeq: 0,
    pickupSerial: 0,
    lastPickupValue: 0,
    feedbackSeq: 0,
    feedbackText: '',
    result: '',
    aliveAllies: 0,
    aliveEnemies: 0,
    warnings: [] as string[],
    log: [] as LogEntry[],
    nightAnnounced: false,
  }),
  events: {
    ko: {
      victimId: stringProp(),
      victimTeam: stringProp(),
      killerId: stringProp(),
      assistId: stringProp(),
      x: numberProp(),
      z: numberProp(),
      generation: numberProp({ min: 0 }),
    },
    purchase: { itemId: stringProp() },
    'use-consumable': {},
    'level-choice': { stat: stringProp() },
    debug: { action: stringProp(), amount: numberProp() },
  },

  start(ctx, self) {
    self.state.matchDurationTicks = Math.max(1, Math.round(self.props.matchSeconds / ctx.deltaSeconds));
    startMatch(ctx, self, false);
  },

  fixedUpdate(ctx, self) {
    if (self.state.bannerTicks > 0) self.state.bannerTicks -= 1;

    /* Live team counts, for the HUD and for the runtime health check. */
    let allies = 0;
    let enemies = 0;
    let allySeats = 0;
    let enemySeats = 0;
    const seen = new Set<string>();
    let duplicates = 0;
    for (const combatant of combatants(ctx)) {
      if (seen.has(combatant.id)) duplicates += 1;
      seen.add(combatant.id);
      const ally = combatant.tags.includes('skirmish-ally');
      if (ally) allySeats += 1;
      else enemySeats += 1;
      const alive = combatant.character?.snapshot().gameplayParameters['gameplay.alive'] === true;
      if (!alive) continue;
      if (ally) allies += 1;
      else enemies += 1;
    }
    self.state.aliveAllies = allies;
    self.state.aliveEnemies = enemies;
    healthCheck(self, { allySeats, enemySeats, duplicates });

    if (self.state.matchState === 'active') {
      self.state.matchTicks += 1;
      const progress = self.state.matchTicks / self.state.matchDurationTicks;
      const phase = phaseOf(progress);
      if (phase !== self.state.phase) {
        self.state.phase = phase;
        if (phase === 'night' && !self.state.nightAnnounced) {
          self.state.nightAnnounced = true;
          for (const combatant of combatants(ctx).slice(0, 2))
            ctx.world.emit(combatant.id, { type: 'bark', payload: { trigger: 'night' } });
        }
      }
      advancePickups(ctx, self);
      if (self.state.matchTicks >= self.state.matchDurationTicks) endMatch(ctx, self);
      return;
    }

    if (self.state.matchState === 'ending') {
      self.state.endingTicks -= 1;
      if (self.state.endingTicks <= 0) {
        /*
         * Reset is its own state, entered before the next match starts. The
         * two never overlap, so a coin despawned here cannot race a coin the
         * next generation spawns.
         */
        self.state.matchState = 'resetting';
        clearPickups(ctx, self);
        self.state.pendingLevelUps = 0;
        log(self, ctx.tick, 'MatchReset', 'clearing match-scoped state');
      }
      return;
    }

    startMatch(ctx, self, true);
  },

  onEvent(ctx, self, event) {
    const payload = event.payload;
    switch (event.type) {
      case 'ko': {
        /* A report from a match that no longer exists is dropped, not applied. */
        if (Math.round(Number(payload.generation ?? -1)) !== self.state.generation) return;
        if (self.state.matchState !== 'active') return;
        const victimTeam = String(payload.victimTeam ?? '');
        const killerId = String(payload.killerId ?? '');
        const assistId = String(payload.assistId ?? '');
        if (victimTeam === 'enemy') self.state.allyScore += 1;
        else self.state.enemyScore += 1;
        if (String(payload.victimId ?? '') === self.props.playerId) self.state.playerDeaths += 1;
        if (victimTeam === 'enemy') {
          spawnCurrency(ctx, self, Number(payload.x ?? 0), Number(payload.z ?? 0), self.props.koCurrency);
          if (killerId === self.props.playerId) {
            self.state.playerKos += 1;
            grantXp(ctx, self, self.props.koXp, 'KO');
          } else if (assistId === self.props.playerId) {
            self.state.playerAssists += 1;
            grantXp(ctx, self, self.props.assistXp, 'Assist');
          }
        }
        log(self, ctx.tick, 'KO', `${String(payload.victimId ?? '')} down`);
        return;
      }
      case 'purchase': {
        if (self.state.matchState !== 'active') return;
        const itemId = String(payload.itemId ?? '');
        const item = SHOP[itemId];
        if (!item) return;
        /*
         * Ownership and equipped state are different facts. Something already
         * owned is re-equipped for nothing — a player who swapped a helmet must
         * not have to buy the first one again — and something already equipped
         * is a no-op rather than a second charge.
         */
        if (item.kind === 'armor' && self.state.owned.includes(itemId)) {
          const current =
            item.slot === 'head' ? self.state.equippedHead : item.slot === 'chest' ? self.state.equippedChest : self.state.equippedLegs;
          if (current === itemId) {
            feedback(self, `${item.label} already equipped`);
            return;
          }
          equipArmor(ctx, self, item.slot, itemId);
          feedback(self, `Equipped ${item.label}`);
          log(self, ctx.tick, 'Equip', item.label);
          return;
        }
        if (self.state.currency < item.price) {
          feedback(self, 'Not enough scrip');
          return;
        }
        /* One deduction, one grant, in one branch that cannot be re-entered. */
        self.state.currency -= item.price;
        if (item.kind === 'consumable') {
          self.state.potions += 1;
          feedback(self, `Bought ${item.label}`);
        } else {
          self.state.owned.push(itemId);
          equipArmor(ctx, self, item.slot, itemId);
          feedback(self, `Equipped ${item.label}`);
        }
        log(self, ctx.tick, 'Purchase', `${item.label} (-${item.price})`);
        return;
      }
      case 'use-consumable': {
        if (self.state.matchState !== 'active' || self.state.potions <= 0) return;
        self.state.potions -= 1;
        ctx.world.emit(self.props.playerId, { type: 'heal', payload: { amount: self.props.potionHeal } });
        log(self, ctx.tick, 'Consumable', 'field ration used');
        return;
      }
      case 'level-choice': {
        /* Exactly one stat per pending level, however many times this fires. */
        if (self.state.pendingLevelUps <= 0) return;
        const stat = String(payload.stat ?? '') as UpgradeStat;
        if (!UPGRADE_STATS.includes(stat)) return;
        self.state.pendingLevelUps -= 1;
        if (stat === 'hp') self.state.upHp += 1;
        else if (stat === 'stamina') self.state.upStamina += 1;
        else if (stat === 'attack') self.state.upAttack += 1;
        else self.state.upDefense += 1;
        pushUpgrades(ctx, self);
        feedback(self, `${stat.toUpperCase()} up!`);
        log(self, ctx.tick, 'StatChoice', stat);
        return;
      }
      case 'debug': {
        if (!self.props.debugEnabled) return;
        const action = String(payload.action ?? '');
        const amount = Number(payload.amount ?? 0);
        if (action === 'xp') grantXp(ctx, self, Math.max(1, amount), 'Debug');
        else if (action === 'coin') {
          /* At the player's feet: a drop nobody can reach proves nothing. */
          const at = ctx.world.get(self.props.playerId)?.worldTransform().position;
          spawnCurrency(ctx, self, (at?.x ?? 0) + amount, at?.z ?? 0, self.props.koCurrency);
        }
        else if (action === 'advance') self.state.matchTicks = Math.min(self.state.matchDurationTicks - 1, self.state.matchTicks + Math.round(amount / ctx.deltaSeconds));
        else if (action === 'end-match' && self.state.matchState === 'active') endMatch(ctx, self);
        else if (action === 'ko-player') ctx.world.emit(self.props.playerId, { type: 'force-ko', payload: {} });
        else if (action === 'currency') self.state.currency += Math.max(0, amount);
        return;
      }
      default:
        return;
    }
  },
});

/* -------------------------------------------------------------------------- */

/**
 * Diagnostics, not a second authority.
 *
 * These are the invariants that would otherwise fail silently and only show up
 * as "the match felt wrong" — a team that lost a member to a spawn bug, a
 * duplicated actor, a field slowly filling with abandoned coins. Recorded for
 * the debug overlay and the headless harness to assert on; nothing here changes
 * the game.
 */
function healthCheck(self: ScriptSelf, counts: { allySeats: number; enemySeats: number; duplicates: number }): void {
  const warnings: string[] = [];
  if (counts.allySeats !== 5) warnings.push(`ally roster is ${counts.allySeats}, expected 5`);
  if (counts.enemySeats !== 5) warnings.push(`enemy roster is ${counts.enemySeats}, expected 5`);
  if (counts.duplicates > 0) warnings.push(`${counts.duplicates} duplicate combatant id(s)`);
  if (self.state.pickups.length > 24) warnings.push(`${self.state.pickups.length} pickups outstanding`);
  if (self.state.log.length > 60) warnings.push('event log exceeded its bound');
  if (self.state.matchState === 'active' && self.state.matchTicks > self.state.matchDurationTicks)
    warnings.push('match clock ran past its duration while active');
  const changed =
    warnings.length !== self.state.warnings.length || warnings.some((entry, index) => entry !== self.state.warnings[index]);
  if (changed) self.state.warnings = warnings;
}

function grantXp(ctx: GameplayContext, self: ScriptSelf, amount: number, reason: string): void {
  if (self.state.matchState !== 'active') return;
  self.state.xp += amount;
  log(self, ctx.tick, 'Xp', `${reason} +${amount}`);
  while (self.state.xp >= self.state.xpToNext) {
    self.state.xp -= self.state.xpToNext;
    self.state.level += 1;
    self.state.xpToNext = xpForLevel(self.state.level);
    self.state.pendingLevelUps += 1;
    log(self, ctx.tick, 'LevelUp', `level ${self.state.level}`);
  }
}

/** Pushes the *totals*, so applying them twice changes nothing. */
function pushUpgrades(ctx: GameplayContext, self: ScriptSelf): void {
  ctx.world.emit(self.props.playerId, {
    type: 'apply-upgrades',
    payload: { hp: self.state.upHp, stamina: self.state.upStamina, attack: self.state.upAttack, defense: self.state.upDefense },
  });
}

function equipArmor(ctx: GameplayContext, self: ScriptSelf, slot: string, itemId: string): void {
  if (slot === 'head') self.state.equippedHead = itemId;
  else if (slot === 'chest') self.state.equippedChest = itemId;
  else if (slot === 'legs') self.state.equippedLegs = itemId;
  else return;
  ctx.world.emit(self.props.playerId, { type: 'equip', payload: { slot, itemId } });
}

function spawnCurrency(ctx: GameplayContext, self: ScriptSelf, x: number, z: number, value: number): void {
  if (self.state.matchState !== 'active') return;
  if (self.state.pickups.length >= 24) {
    /* Bounded: the oldest drop leaves rather than letting the field fill up. */
    const oldest = self.state.pickups.shift();
    if (oldest) ctx.world.despawn(oldest.id);
  }
  self.state.pickupSerial += 1;
  const id = `wildlands-coin-${self.state.generation}-${self.state.pickupSerial}`;
  ctx.world.spawn({
    id,
    prefab: {
      assetType: 'game-object-prefab',
      assetId: self.props.pickupPrefabId,
      version: self.props.pickupPrefabVersion,
      contentHash: self.props.pickupPrefabHash,
    },
    transform: { position: { x, y: 0.6, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
  });
  self.state.pickups.push({ id, x, z, ticks: Math.round(self.props.pickupLifetimeSeconds / ctx.deltaSeconds), value });
  log(self, ctx.tick, 'CurrencyDrop', `${value} at ${x.toFixed(1)}, ${z.toFixed(1)}`);
}

/** Auto-collection for the player only, plus the drops' bounded lifetime. */
function advancePickups(ctx: GameplayContext, self: ScriptSelf): void {
  if (self.state.pickups.length === 0) return;
  const player = ctx.world.get(self.props.playerId);
  const position = player?.worldTransform().position;
  const remaining: Pickup[] = [];
  for (const pickup of self.state.pickups) {
    pickup.ticks -= 1;
    const collected =
      position !== undefined && Math.hypot(position.x - pickup.x, position.z - pickup.z) <= self.props.pickupRadius;
    if (collected) {
      /* Counted once, here, and the object is gone in the same breath. */
      self.state.currency += pickup.value;
      self.state.currencyEarned += pickup.value;
      self.state.lastPickupValue = pickup.value;
      self.state.pickupSeq += 1;
      ctx.world.despawn(pickup.id);
      log(self, ctx.tick, 'CurrencyPickup', `+${pickup.value}`);
      continue;
    }
    if (pickup.ticks <= 0) {
      ctx.world.despawn(pickup.id);
      continue;
    }
    remaining.push(pickup);
  }
  self.state.pickups = remaining;
}

function endMatch(ctx: GameplayContext, self: ScriptSelf): void {
  self.state.matchState = 'ending';
  self.state.endingTicks = Math.max(1, Math.round(self.props.endingSeconds / ctx.deltaSeconds));
  self.state.pendingLevelUps = 0;
  self.state.result =
    self.state.allyScore > self.state.enemyScore ? 'victory' : self.state.allyScore < self.state.enemyScore ? 'defeat' : 'draw';
  /* Everyone stops fighting before any reward can be scored against a match
   * that has already been decided. */
  for (const combatant of combatants(ctx)) ctx.world.emit(combatant.id, { type: 'set-active', payload: { active: false } });
  log(self, ctx.tick, 'MatchEnd', `${self.state.result} ${self.state.allyScore}-${self.state.enemyScore}`);
}
