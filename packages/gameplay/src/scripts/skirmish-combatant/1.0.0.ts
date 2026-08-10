/**
 * Wildlands Skirmish — one combatant.
 *
 * Every fighter in the match runs this script: the player and all nine NPCs.
 * The only difference between them is where intent comes from. A human-bound
 * character is driven by the device sampler and this script only *observes*
 * what the state machine did; an AI-bound character has the same script decide
 * what it wants and hand that decision to the same intent channel. Stats,
 * stamina, the damage pipeline, defeat, respawn, equipment and barks are
 * literally the same code for both, so "the player hits harder than an NPC for
 * a reason nobody can find" is not representable.
 *
 * Nothing here selects a clip. Attacks are observed through the character's own
 * action state, hit reactions are requested through a `gameplay.*` parameter the
 * behaviour asset reacts to, and equipment changes are expressed as a motion
 * *context*, which the canonical contextual bindings resolve.
 */
import {
  booleanProp,
  defineGameplayScript,
  enumProp,
  numberProp,
  stringProp,
  type GameplayContext,
  type GameplayObjectView,
} from '@atc/gameplay-sdk';

/** Held-equipment archetypes, in D-pad order. Each names a motion context. */
const LOADOUTS = [
  { id: 'sword', context: 'sword', label: 'Longsword', power: 1, range: 2.6, arcDeg: 110, cost: 20, defense: 0, guard: true },
  { id: 'shield', context: 'shield', label: 'Sword & Shield', power: 0.78, range: 2.3, arcDeg: 95, cost: 16, defense: 4, guard: true },
  { id: 'magic', context: 'magic', label: 'Ember Focus', power: 1.3, range: 6, arcDeg: 44, cost: 30, defense: -1, guard: false },
  { id: 'throw', context: 'throw', label: 'Throwing Blades', power: 0.95, range: 8, arcDeg: 26, cost: 24, defense: 0, guard: false },
] as const;

/** Armor, by slot. Ids are what the shop sells and what the HUD shows. */
const ARMOR: Record<string, { slot: 'head' | 'chest' | 'legs'; hp: number; defense: number; stamina: number }> = {
  'scout-hood': { slot: 'head', hp: 0, defense: 2, stamina: 4 },
  'iron-helm': { slot: 'head', hp: 8, defense: 4, stamina: -4 },
  'leather-vest': { slot: 'chest', hp: 10, defense: 3, stamina: 0 },
  'plated-cuirass': { slot: 'chest', hp: 22, defense: 7, stamina: -8 },
  'runner-greaves': { slot: 'legs', hp: 0, defense: 1, stamina: 14 },
  'iron-greaves': { slot: 'legs', hp: 6, defense: 4, stamina: -2 },
};

type AiState = 'idle' | 'approach' | 'engage' | 'recover' | 'return';

/** The authored tuning this script reads. Named so helpers can be typed. */
type CombatantProps = {
  team: string;
  seat: number;
  isPlayer: boolean;
  directorId: string;
  spawnX: number;
  spawnZ: number;
  baseMaxHp: number;
  baseMaxStamina: number;
  baseAttack: number;
  baseDefense: number;
  staminaRegenPerSecond: number;
  dodgeStaminaCost: number;
  attackWindupSeconds: number;
  aggroRadius: number;
  leashRadius: number;
  arenaRadius: number;
  respawnSeconds: number;
  spawnProtectionSeconds: number;
  safeZoneRadius: number;
  safeZoneX: number;
  safeZoneZ: number;
  startingLoadout: number;
};

/** Everything that changes on a tick. Read by the HUD through the snapshot. */
type CombatantState = {
  /** Mirrored from the authored props so one snapshot answers "whose side?". */
  team: string;
  seat: number;
  generation: number;
  active: boolean;
  alive: boolean;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  attack: number;
  defense: number;
  upHp: number;
  upStamina: number;
  upAttack: number;
  upDefense: number;
  loadout: number;
  loadoutId: string;
  pendingLoadout: number;
  head: string;
  chest: string;
  legs: string;
  downTicks: number;
  protectionTicks: number;
  hitSeq: number;
  hitAmount: number;
  healSeq: number;
  healAmount: number;
  kos: number;
  deaths: number;
  lastActionState: string;
  attackTicks: number;
  attackPower: number;
  attackRange: number;
  attackArc: number;
  targetId: string;
  targetSeat: number;
  aiState: AiState;
  aiTicks: number;
  retargetTicks: number;
  lastDamagerId: string;
  previousDamagerId: string;
  barkSeq: number;
  barkText: string;
  barkCooldown: number;
  stuckTicks: number;
  detourTicks: number;
  detourSign: number;
  lastX: number;
  lastZ: number;
  recoveries: number;
  threat: boolean;
};

interface ScriptSelf {
  readonly gameObjectId: string;
  readonly props: CombatantProps;
  readonly state: CombatantState;
}

/** Short lines, grouped by trigger. Picked with `ctx.random()`, never a clock. */
const BARKS: Record<string, { ally: string[]; enemy: string[] }> = {
  spotted: { ally: ['Contact!', 'Enemy on the ridge!', 'I see one!'], enemy: ['Intruders!', 'There they are!', 'Cut them down!'] },
  attack: { ally: ['On me!', 'Pushing in!', 'Take this!'], enemy: ['For the camp!', 'Break them!', 'No mercy!'] },
  lowHp: { ally: ['I need cover!', 'Falling back!', "I'm hurt!"], enemy: ['Hold the line!', 'Not yet!', 'Damn it!'] },
  killed: { ally: ['Target down!', 'One less!', 'Clear!'], enemy: ['Got one!', 'Down you go!', 'Weak.'] },
  died: { ally: ['Agh — regrouping!', "I'm down!", 'Cover me!'], enemy: ['Aargh!', 'Impossible...', 'Fall... back...'] },
  night: { ally: ['Light is going.', 'Watch the treeline.'], enemy: ['Dark suits us.', 'They cannot see us now.'] },
};

function yawTo(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

function wrapAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

/** Reads a published `gameplay.*` number from another combatant. */
function parameterNumber(view: GameplayObjectView, name: string): number {
  const value = view.character?.snapshot().gameplayParameters[name];
  return typeof value === 'number' ? value : 0;
}

function isAlive(view: GameplayObjectView): boolean {
  return view.character?.snapshot().gameplayParameters['gameplay.alive'] === true;
}

/** Every combatant of one team, in deterministic scene order. */
function teamOf(ctx: GameplayContext, team: string): GameplayObjectView[] {
  return ctx.world.findByTag(team === 'ally' ? 'skirmish-ally' : 'skirmish-enemy');
}

export default defineGameplayScript({
  id: 'skirmish-combatant',
  version: '1.0.0',
  displayName: 'Skirmish Combatant',
  properties: {
    team: enumProp(['ally', 'enemy'], { default: 'ally', instanceOverride: true }),
    seat: numberProp({ default: 1, min: 1, max: 8, step: 1, instanceOverride: true }),
    isPlayer: booleanProp({ default: false, instanceOverride: true }),
    directorId: stringProp({ default: 'match-director', instanceOverride: true }),
    spawnX: numberProp({ default: 0, instanceOverride: true }),
    spawnZ: numberProp({ default: 30, instanceOverride: true }),
    baseMaxHp: numberProp({ default: 120, min: 1, instanceOverride: true }),
    baseMaxStamina: numberProp({ default: 100, min: 1, instanceOverride: true }),
    baseAttack: numberProp({ default: 22, min: 1, instanceOverride: true }),
    baseDefense: numberProp({ default: 5, min: 0, instanceOverride: true }),
    staminaRegenPerSecond: numberProp({ default: 11, min: 0, instanceOverride: true }),
    dodgeStaminaCost: numberProp({ default: 24, min: 0, instanceOverride: true }),
    attackWindupSeconds: numberProp({ default: 0.22, min: 0.02, instanceOverride: true }),
    aggroRadius: numberProp({ default: 26, min: 1, instanceOverride: true }),
    leashRadius: numberProp({ default: 40, min: 2, instanceOverride: true }),
    arenaRadius: numberProp({ default: 46, min: 5, instanceOverride: true }),
    respawnSeconds: numberProp({ default: 3, min: 0.5, instanceOverride: true }),
    spawnProtectionSeconds: numberProp({ default: 2, min: 0, instanceOverride: true }),
    safeZoneRadius: numberProp({ default: 10, min: 0, instanceOverride: true }),
    safeZoneX: numberProp({ default: 0, instanceOverride: true }),
    safeZoneZ: numberProp({ default: 30, instanceOverride: true }),
    startingLoadout: numberProp({ default: 0, min: 0, max: 3, step: 1, instanceOverride: true }),
  },
  state: ({ props }): CombatantState => ({
    team: props.team,
    seat: props.seat,
    generation: 0,
    active: true,
    alive: true,
    hp: props.baseMaxHp,
    maxHp: props.baseMaxHp,
    stamina: props.baseMaxStamina,
    maxStamina: props.baseMaxStamina,
    attack: props.baseAttack,
    defense: props.baseDefense,
    /** Chosen stat upgrades, as absolute counts so re-applying is idempotent. */
    upHp: 0,
    upStamina: 0,
    upAttack: 0,
    upDefense: 0,
    loadout: props.startingLoadout,
    loadoutId: LOADOUTS[props.startingLoadout]?.id ?? 'sword',
    /** Queued while an action is mid-swing, so a switch cannot corrupt it. */
    pendingLoadout: -1,
    head: '',
    chest: '',
    legs: '',
    downTicks: 0,
    protectionTicks: 0,
    /** Feedback handshake with the HUD: a new sequence means a new number. */
    hitSeq: 0,
    hitAmount: 0,
    healSeq: 0,
    healAmount: 0,
    kos: 0,
    deaths: 0,
    lastActionState: '',
    attackTicks: -1,
    attackPower: 0,
    attackRange: 0,
    attackArc: 0,
    targetId: '',
    targetSeat: 0,
    aiState: 'idle' as AiState,
    aiTicks: 0,
    retargetTicks: 0,
    lastDamagerId: '',
    previousDamagerId: '',
    barkSeq: 0,
    barkText: '',
    barkCooldown: 0,
    stuckTicks: 0,
    detourTicks: 0,
    detourSign: 1,
    lastX: 0,
    lastZ: 0,
    recoveries: 0,
    threat: false,
  }),
  events: {
    /** Applied damage is computed here, once, by the target. */
    damage: { power: numberProp({ min: 0 }), sourceId: stringProp() },
    heal: { amount: numberProp({ min: 0 }) },
    'set-loadout': { index: numberProp({ min: 0, max: 3 }) },
    equip: { slot: stringProp(), itemId: stringProp() },
    'apply-upgrades': { hp: numberProp({ min: 0 }), stamina: numberProp({ min: 0 }), attack: numberProp({ min: 0 }), defense: numberProp({ min: 0 }) },
    /** A new match generation. Everything match-scoped returns to baseline. */
    configure: { generation: numberProp({ min: 0 }), active: booleanProp() },
    'set-active': { active: booleanProp() },
    bark: { trigger: stringProp() },
    'force-ko': {},
  },

  start(ctx, self) {
    const transform = ctx.self.worldTransform();
    self.state.lastX = transform.position.x;
    self.state.lastZ = transform.position.z;
    applyLoadout(ctx, self, self.props.startingLoadout, true);
    recomputeStats(self, true);
    publish(ctx, self);
  },

  fixedUpdate(ctx, self) {
    const character = ctx.self.character;
    if (!character) return;
    const snapshot = character.snapshot();
    const position = snapshot.worldTransform.position;

    if (self.state.protectionTicks > 0) self.state.protectionTicks -= 1;
    if (self.state.barkCooldown > 0) self.state.barkCooldown -= 1;

    if (!self.state.alive) {
      self.state.downTicks -= 1;
      if (self.props.isPlayer !== true) character.setIntent({});
      if (self.state.downTicks <= 0 && self.state.active) respawn(ctx, self);
      publish(ctx, self);
      return;
    }

    /* Stamina, always clamped, and never negative or above the current max. */
    self.state.stamina = Math.max(
      0,
      Math.min(self.state.maxStamina, self.state.stamina + self.props.staminaRegenPerSecond * ctx.deltaSeconds),
    );

    observeActions(ctx, self, snapshot.actionStateId);
    if (self.state.attackTicks >= 0) {
      self.state.attackTicks -= 1;
      if (self.state.attackTicks < 0) resolveAttack(ctx, self);
    }

    /* A queued equipment switch lands the moment the action layer is idle. */
    if (self.state.pendingLoadout >= 0 && !isActionBusy(snapshot.actionStateId)) {
      const queued = self.state.pendingLoadout;
      self.state.pendingLoadout = -1;
      applyLoadout(ctx, self, queued, false);
    }

    recoverIfOutOfBounds(ctx, self, position);
    if (self.props.isPlayer !== true && self.state.active) driveAi(ctx, self, snapshot);
    else if (self.props.isPlayer !== true) ctx.self.character?.setIntent({});

    publish(ctx, self);
  },

  onEvent(ctx, self, event) {
    const payload = event.payload;
    switch (event.type) {
      case 'damage': {
        if (!self.state.alive || !self.state.active || self.state.protectionTicks > 0) return;
        const power = Number(payload.power ?? 0);
        /*
         * The one damage pipeline. Attack power arrives from the attacker and
         * defense is applied by the victim, so both halves of every exchange —
         * player hitting an NPC and an NPC hitting the player — go through this
         * single monotonic, clamped formula.
         */
        const applied = Math.max(1, Math.round(power - self.state.defense * 0.6));
        const before = self.state.hp;
        self.state.hp = Math.max(0, before - applied);
        const delta = before - self.state.hp;
        /* The HUD shows the *actual* HP delta, never a second prediction. */
        self.state.hitAmount = delta;
        self.state.hitSeq += 1;
        const sourceId = String(payload.sourceId ?? '');
        if (sourceId && sourceId !== self.state.lastDamagerId) {
          self.state.previousDamagerId = self.state.lastDamagerId;
          self.state.lastDamagerId = sourceId;
        }
        /* The behaviour asset owns the reaction; this only states the fact. */
        ctx.self.character?.setGameplayParameter('gameplay.damaged', true, 4);
        if (self.state.hp === 0) defeat(ctx, self);
        else if (self.state.hp <= self.state.maxHp * 0.3) bark(ctx, self, 'lowHp');
        return;
      }
      case 'heal': {
        if (!self.state.alive) return;
        const before = self.state.hp;
        self.state.hp = Math.min(self.state.maxHp, before + Number(payload.amount ?? 0));
        const restored = self.state.hp - before;
        if (restored <= 0) return;
        self.state.healAmount = restored;
        self.state.healSeq += 1;
        return;
      }
      case 'set-loadout': {
        const index = Math.max(0, Math.min(LOADOUTS.length - 1, Math.round(Number(payload.index ?? 0))));
        if (index === self.state.loadout && self.state.pendingLoadout < 0) return;
        const busy = isActionBusy(ctx.self.character?.snapshot().actionStateId ?? '');
        if (busy) self.state.pendingLoadout = index;
        else applyLoadout(ctx, self, index, false);
        return;
      }
      case 'equip': {
        const slot = String(payload.slot ?? '');
        const itemId = String(payload.itemId ?? '');
        if (itemId !== '' && ARMOR[itemId]?.slot !== slot) return;
        /* One state change: the slot is *replaced*, so no modifier can stack. */
        if (slot === 'head') self.state.head = itemId;
        else if (slot === 'chest') self.state.chest = itemId;
        else if (slot === 'legs') self.state.legs = itemId;
        else return;
        recomputeStats(self, false);
        return;
      }
      case 'apply-upgrades': {
        self.state.upHp = Math.max(0, Math.round(Number(payload.hp ?? 0)));
        self.state.upStamina = Math.max(0, Math.round(Number(payload.stamina ?? 0)));
        self.state.upAttack = Math.max(0, Math.round(Number(payload.attack ?? 0)));
        self.state.upDefense = Math.max(0, Math.round(Number(payload.defense ?? 0)));
        recomputeStats(self, false);
        return;
      }
      case 'configure': {
        self.state.generation = Math.round(Number(payload.generation ?? 0));
        self.state.active = payload.active !== false;
        resetForMatch(ctx, self);
        return;
      }
      case 'set-active': {
        self.state.active = payload.active !== false;
        return;
      }
      case 'bark':
        bark(ctx, self, String(payload.trigger ?? ''));
        return;
      case 'force-ko':
        if (self.state.alive) {
          self.state.hp = 0;
          defeat(ctx, self);
        }
        return;
      default:
        return;
    }
  },
});

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */


function isActionBusy(actionStateId: string): boolean {
  return actionStateId !== '' && actionStateId !== 'action-none';
}

function isAttackState(actionStateId: string): boolean {
  return actionStateId === 'attack-01' || actionStateId === 'attack-02';
}

/**
 * Derives authoritative stats from base + upgrades + armor + held equipment.
 *
 * Recomputed from scratch every time rather than adjusted incrementally: an
 * incremental update has to remove exactly what it added, and "the modifier was
 * removed twice" is precisely the bug that makes a re-equipped chestplate leave
 * a character permanently weaker.
 */
function recomputeStats(self: ScriptSelf, full: boolean): void {
  const loadout = LOADOUTS[self.state.loadout] ?? LOADOUTS[0]!;
  let hp = self.props.baseMaxHp + self.state.upHp * 12;
  let stamina = self.props.baseMaxStamina + self.state.upStamina * 10;
  let defense = self.props.baseDefense + self.state.upDefense * 2 + loadout.defense;
  const attack = self.props.baseAttack + self.state.upAttack * 4;
  for (const itemId of [self.state.head, self.state.chest, self.state.legs]) {
    const armor = itemId === '' ? undefined : ARMOR[itemId];
    if (!armor) continue;
    hp += armor.hp;
    stamina += armor.stamina;
    defense += armor.defense;
  }
  self.state.maxHp = Math.max(1, Math.round(hp));
  self.state.maxStamina = Math.max(20, Math.round(stamina));
  self.state.attack = Math.max(1, Math.round(attack));
  self.state.defense = Math.max(0, Math.round(defense));
  self.state.hp = full ? self.state.maxHp : Math.min(self.state.hp, self.state.maxHp);
  self.state.stamina = full ? self.state.maxStamina : Math.min(self.state.stamina, self.state.maxStamina);
}

function applyLoadout(ctx: GameplayContext, self: ScriptSelf, index: number, initial: boolean): void {
  const clamped = Math.max(0, Math.min(LOADOUTS.length - 1, Math.round(index)));
  const loadout = LOADOUTS[clamped]!;
  self.state.loadout = clamped;
  self.state.loadoutId = loadout.id;
  /* The context, not a clip: contextual bindings resolve the rest. */
  ctx.self.character?.setMotionContext(loadout.context);
  if (!initial) recomputeStats(self, false);
}

/** Publishes the small facts other combatants and the HUD read. */
function publish(ctx: GameplayContext, self: ScriptSelf): void {
  const character = ctx.self.character;
  if (!character) return;
  character.setGameplayParameter('gameplay.alive', self.state.alive === true);
  character.setGameplayParameter('gameplay.seat', self.props.seat);
  character.setGameplayParameter('gameplay.targetSeat', self.state.targetSeat);
  character.setGameplayParameter('gameplay.threat', self.state.threat === true);
}

function bark(ctx: GameplayContext, self: ScriptSelf, trigger: string): void {
  if (self.state.barkCooldown > 0) return;
  const group = BARKS[trigger];
  if (!group) return;
  const lines = self.props.team === 'ally' ? group.ally : group.enemy;
  const line = lines[Math.min(lines.length - 1, Math.floor(ctx.random() * lines.length))];
  if (line === undefined) return;
  self.state.barkText = line;
  self.state.barkSeq += 1;
  self.state.barkCooldown = 240;
}

/**
 * Watches what the state machine actually did.
 *
 * Stamina is spent when the character *enters* an attack or a dodge, not when a
 * button is pressed: the graph's own acceptance windows already decide whether a
 * press becomes a swing, so charging on the press would let a mashed button
 * drain a character who never attacked.
 */
function observeActions(ctx: GameplayContext, self: ScriptSelf, actionStateId: string): void {
  const previous = self.state.lastActionState;
  self.state.lastActionState = actionStateId;
  if (actionStateId === previous) return;
  if (isAttackState(actionStateId)) {
    const loadout = LOADOUTS[self.state.loadout] ?? LOADOUTS[0]!;
    const spent = Math.min(self.state.stamina, loadout.cost);
    /* A swing thrown on an empty bar still lands, but weakly. */
    const exhausted = self.state.stamina < loadout.cost;
    self.state.stamina = Math.max(0, self.state.stamina - spent);
    self.state.attackTicks = Math.max(1, Math.round(self.props.attackWindupSeconds / ctx.deltaSeconds));
    self.state.attackPower = self.state.attack * loadout.power * (exhausted ? 0.35 : 1);
    self.state.attackRange = loadout.range;
    self.state.attackArc = (loadout.arcDeg * Math.PI) / 180;
    /* Attacking gives up the spawn shield, so it cannot be camped behind. */
    if (self.state.protectionTicks > 0) self.state.protectionTicks = 0;
    bark(ctx, self, 'attack');
  } else if (actionStateId === 'dodge') {
    self.state.stamina = Math.max(0, self.state.stamina - self.props.dodgeStaminaCost);
  }
}

/**
 * Turns one swing into damage, once.
 *
 * The single authoritative hit for the attack that started `attackWindup`
 * seconds ago. Everything downstream — the number on screen, the reaction, the
 * KO, the reward — is driven from the event this produces, so no two detectors
 * can disagree about whether a hit happened.
 */
function resolveAttack(ctx: GameplayContext, self: ScriptSelf): void {
  if (!self.state.alive || !self.state.active) return;
  const origin = ctx.self.worldTransform().position;
  const facing = ctx.self.character?.snapshot().worldTransform.rotation;
  const yaw = facing ? Math.atan2(2 * (facing.w * facing.y), 1 - 2 * (facing.y * facing.y)) : 0;
  const hostiles = teamOf(ctx, self.props.team === 'ally' ? 'enemy' : 'ally');
  let hits = 0;
  for (const hostile of hostiles) {
    if (hits >= 2) break;
    if (hostile.id === ctx.self.id || !isAlive(hostile)) continue;
    const target = hostile.worldTransform().position;
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const distance = Math.hypot(dx, dz);
    if (distance > self.state.attackRange) continue;
    if (distance > 0.2 && Math.abs(wrapAngle(yawTo(dx, dz) - yaw)) > self.state.attackArc / 2) continue;
    ctx.world.emit(hostile.id, { type: 'damage', payload: { power: self.state.attackPower, sourceId: ctx.self.id } });
    hits += 1;
  }
}

function spawnPoint(ctx: GameplayContext, self: ScriptSelf): { x: number; z: number } {
  /*
   * Candidates on a ring around the team's base, scored by how far the nearest
   * living hostile is. Deterministic scan order, so two runs of one match pick
   * the same spawn.
   */
  const hostiles = teamOf(ctx, self.props.team === 'ally' ? 'enemy' : 'ally').filter(isAlive);
  let best = { x: self.props.spawnX, z: self.props.spawnZ };
  let bestScore = -Infinity;
  for (let index = 0; index < 6; index += 1) {
    const angle = (Math.PI * 2 * index) / 6 + self.props.seat * 0.31;
    const x = self.props.spawnX + Math.cos(angle) * 4.5;
    const z = self.props.spawnZ + Math.sin(angle) * 4.5;
    let nearest = 999;
    for (const hostile of hostiles) {
      const position = hostile.worldTransform().position;
      nearest = Math.min(nearest, Math.hypot(position.x - x, position.z - z));
    }
    if (nearest > bestScore) {
      bestScore = nearest;
      best = { x, z };
    }
  }
  return best;
}

function defeat(ctx: GameplayContext, self: ScriptSelf): void {
  self.state.alive = false;
  self.state.deaths += 1;
  self.state.downTicks = Math.max(1, Math.round(self.props.respawnSeconds / ctx.deltaSeconds));
  self.state.attackTicks = -1;
  self.state.targetId = '';
  self.state.targetSeat = 0;
  self.state.threat = false;
  self.state.barkCooldown = 0;
  bark(ctx, self, 'died');
  /*
   * Out of the fight the instant it is decided: moved to the team's own base,
   * inert, untargetable, and counted down there. No second actor is created, so
   * a respawn cannot leave a duplicate behind.
   */
  const point = { x: self.props.spawnX, z: self.props.spawnZ };
  ctx.self.character?.command({ type: 'teleport', position: { x: point.x, y: 0.2, z: point.z }, velocity: 'clear' });
  ctx.world.emit(self.props.directorId, {
    type: 'ko',
    payload: {
      victimId: ctx.self.id,
      victimTeam: self.props.team,
      killerId: self.state.lastDamagerId,
      assistId: self.state.previousDamagerId,
      x: point.x,
      z: point.z,
      generation: self.state.generation,
    },
  });
  if (self.state.lastDamagerId !== '') ctx.world.emit(self.state.lastDamagerId, { type: 'bark', payload: { trigger: 'killed' } });
  self.state.lastDamagerId = '';
  self.state.previousDamagerId = '';
}

function respawn(ctx: GameplayContext, self: ScriptSelf): void {
  const point = spawnPoint(ctx, self);
  ctx.self.character?.command({
    type: 'teleport',
    position: { x: point.x, y: 0.2, z: point.z },
    yawRad: yawTo(-point.x, -point.z),
    velocity: 'clear',
  });
  self.state.alive = true;
  self.state.hp = self.state.maxHp;
  self.state.stamina = self.state.maxStamina;
  self.state.protectionTicks = Math.max(0, Math.round(self.props.spawnProtectionSeconds / ctx.deltaSeconds));
  self.state.aiState = 'approach';
  self.state.stuckTicks = 0;
  self.state.lastX = point.x;
  self.state.lastZ = point.z;
}

/** Everything match-scoped returns to its authored baseline. */
function resetForMatch(ctx: GameplayContext, self: ScriptSelf): void {
  self.state.upHp = 0;
  self.state.upStamina = 0;
  self.state.upAttack = 0;
  self.state.upDefense = 0;
  self.state.head = '';
  self.state.chest = '';
  self.state.legs = '';
  self.state.kos = 0;
  self.state.deaths = 0;
  self.state.hitSeq = 0;
  self.state.healSeq = 0;
  self.state.barkSeq = 0;
  self.state.barkText = '';
  self.state.pendingLoadout = -1;
  self.state.attackTicks = -1;
  self.state.lastDamagerId = '';
  self.state.previousDamagerId = '';
  self.state.targetId = '';
  self.state.targetSeat = 0;
  self.state.threat = false;
  self.state.alive = true;
  self.state.downTicks = 0;
  applyLoadout(ctx, self, self.props.startingLoadout, true);
  recomputeStats(self, true);
  respawn(ctx, self);
}

/**
 * Rescues a character the world has lost.
 *
 * Under the terrain, outside the arena, or at an impossible coordinate. The
 * recovery goes through the character's own motion authority and is deliberately
 * *not* a KO: falling through the floor is not something a player should be
 * scored for.
 */
function recoverIfOutOfBounds(ctx: GameplayContext, self: ScriptSelf, position: { x: number; y: number; z: number }): void {
  const broken =
    !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z) ||
    position.y < -4 || position.y > 40 ||
    Math.hypot(position.x, position.z) > self.props.arenaRadius * 1.25;
  if (!broken) return;
  const point = spawnPoint(ctx, self);
  ctx.self.character?.command({ type: 'teleport', position: { x: point.x, y: 0.4, z: point.z }, velocity: 'clear' });
  self.state.recoveries += 1;
  self.state.stuckTicks = 0;
}

/* -------------------------------------------------------------------------- */
/* AI                                                                          */
/* -------------------------------------------------------------------------- */

interface AiSnapshot {
  worldTransform: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } };
  actionStateId: string;
}

/**
 * One small state machine, shared by all nine NPCs.
 *
 * It produces normalized intent and nothing else — the same frames a controller
 * produces — so an NPC's attack is accepted, recovered from and animated by
 * exactly the rules a human's is.
 */
function driveAi(ctx: GameplayContext, self: ScriptSelf, snapshot: AiSnapshot): void {
  const character = ctx.self.character;
  if (!character) return;
  const position = snapshot.worldTransform.position;
  const rotation = snapshot.worldTransform.rotation;
  const yaw = Math.atan2(2 * (rotation.w * rotation.y), 1 - 2 * (rotation.y * rotation.y));

  if (self.state.retargetTicks > 0) self.state.retargetTicks -= 1;
  else {
    acquireTarget(ctx, self, position);
    self.state.retargetTicks = 15;
  }

  const target = self.state.targetId === '' ? undefined : ctx.world.get(self.state.targetId);
  const targetAlive = target !== undefined && isAlive(target);
  const targetPosition = targetAlive ? target.worldTransform().position : undefined;
  const distance = targetPosition ? Math.hypot(targetPosition.x - position.x, targetPosition.z - position.z) : Infinity;
  const homeDistance = Math.hypot(position.x, position.z);
  const loadout = LOADOUTS[self.state.loadout] ?? LOADOUTS[0]!;

  let next: AiState;
  if (homeDistance > self.props.leashRadius) next = 'return';
  else if (!targetAlive || distance > self.props.aggroRadius) next = 'idle';
  else if (self.state.stamina < self.state.maxStamina * 0.22 && distance < loadout.range * 1.6) next = 'recover';
  else if (distance > loadout.range * 0.82) next = 'approach';
  else next = 'engage';
  if (next !== self.state.aiState) {
    if (next === 'approach' && self.state.aiState === 'idle') bark(ctx, self, 'spotted');
    self.state.aiState = next;
    self.state.aiTicks = 0;
  } else self.state.aiTicks += 1;

  let moveX = 0;
  let moveZ = 0;
  let magnitude = 0;
  let attack = false;
  let dodge = false;

  if (next === 'return') {
    moveX = -position.x;
    moveZ = -position.z;
    magnitude = 1;
  } else if (next === 'idle') {
    /*
     * With nobody in range, push toward the contested middle rather than mill
     * around the base. Each seat aims at its own lane, so a team advances as a
     * spread line and the two sides reliably meet near the landmark.
     */
    const laneX = (self.props.seat - 3) * 6.5;
    const laneZ = -self.props.spawnZ * 0.3;
    moveX = laneX - position.x;
    moveZ = laneZ - position.z;
    magnitude = Math.hypot(moveX, moveZ) > 2.5 ? 0.72 : 0;
  } else if (targetPosition) {
    const toX = targetPosition.x - position.x;
    const toZ = targetPosition.z - position.z;
    if (next === 'recover') {
      moveX = -toX;
      moveZ = -toZ;
      magnitude = 0.75;
      dodge = self.state.aiTicks === 4 && self.state.stamina > self.props.dodgeStaminaCost;
    } else if (next === 'approach') {
      moveX = toX;
      moveZ = toZ;
      magnitude = 1;
    } else {
      /* In range: keep facing pressure on the target, then swing. */
      moveX = toX;
      moveZ = toZ;
      magnitude = distance > loadout.range * 0.55 ? 0.5 : 0.28;
      const facingError = Math.abs(wrapAngle(yawTo(toX, toZ) - yaw));
      const ready = !isActionBusy(snapshot.actionStateId) && self.state.stamina > loadout.cost;
      attack = ready && facingError < 0.42 && self.state.aiTicks % 40 === 5;
      dodge = !attack && ready && facingError < 1 && ctx.random() < 0.012 && self.state.stamina > self.props.dodgeStaminaCost + loadout.cost;
    }
  }

  /* Enemies keep out of the player's shop: browsing must not be a death trap. */
  if (self.props.team === 'enemy' && self.props.safeZoneRadius > 0) {
    const toSafeX = position.x - self.props.safeZoneX;
    const toSafeZ = position.z - self.props.safeZoneZ;
    const safeDistance = Math.hypot(toSafeX, toSafeZ);
    if (safeDistance < self.props.safeZoneRadius) {
      moveX = toSafeX;
      moveZ = toSafeZ;
      magnitude = 1;
      attack = false;
    }
  }

  const { pushX, pushZ } = separation(ctx, self, position);
  moveX += pushX;
  moveZ += pushZ;

  const moved = Math.hypot(position.x - self.state.lastX, position.z - self.state.lastZ);
  self.state.lastX = position.x;
  self.state.lastZ = position.z;
  if (magnitude > 0.3 && moved < 0.012) self.state.stuckTicks += 1;
  else self.state.stuckTicks = Math.max(0, self.state.stuckTicks - 2);

  if (self.state.stuckTicks > 45 && self.state.detourTicks <= 0) {
    /* Step one: try around the obstacle before anything more drastic. */
    self.state.detourTicks = 40;
    self.state.detourSign = ctx.random() < 0.5 ? -1 : 1;
  }
  if (self.state.detourTicks > 0) {
    self.state.detourTicks -= 1;
    const sideX = moveZ * self.state.detourSign;
    const sideZ = -moveX * self.state.detourSign;
    moveX += sideX * 1.4;
    moveZ += sideZ * 1.4;
    magnitude = Math.max(magnitude, 0.8);
  }
  if (self.state.stuckTicks > 200) {
    /* Step two, and only then: reposition through the motion authority. */
    const point = spawnPoint(ctx, self);
    character.command({ type: 'teleport', position: { x: point.x, y: 0.3, z: point.z }, velocity: 'clear' });
    self.state.stuckTicks = 0;
    self.state.detourTicks = 0;
    self.state.recoveries += 1;
  }

  const length = Math.hypot(moveX, moveZ);
  const normalX = length > 1e-4 ? moveX / length : 0;
  const normalZ = length > 1e-4 ? moveZ / length : 0;
  /*
   * World direction expressed as camera-relative stick, because that is what
   * the project's movement policy says a stick means. The AI therefore feeds
   * exactly the frame a controller would have to feed to go the same way.
   */
  const cos = Math.cos(ctx.cameraYawRad);
  const sin = Math.sin(ctx.cameraYawRad);
  const stickX = (-cos * normalX + sin * normalZ) * magnitude;
  const stickY = (sin * normalX + cos * normalZ) * magnitude;

  character.setIntent({
    moveX: stickX,
    moveY: stickY,
    buttons: { PrimaryAction: attack, Dodge: dodge, Guard: next === 'recover' && loadout.guard && !dodge },
  });
  self.state.threat = self.state.targetId !== '' && targetAlive && distance < 14 && target?.tags.includes('skirmish-player') === true;
}

/**
 * Picks a hostile, spreading pressure across the enemy team.
 *
 * The count of teammates already committed to a candidate is read from their
 * own published `gameplay.targetSeat`, so nobody needs a shared blackboard and
 * five NPCs cannot all silently converge on one victim while others idle.
 */
function acquireTarget(ctx: GameplayContext, self: ScriptSelf, position: { x: number; z: number }): void {
  const hostiles = teamOf(ctx, self.props.team === 'ally' ? 'enemy' : 'ally');
  const friends = teamOf(ctx, self.props.team);
  let bestId = '';
  let bestSeat = 0;
  let bestScore = Infinity;
  for (const hostile of hostiles) {
    if (!isAlive(hostile)) continue;
    const hostilePosition = hostile.worldTransform().position;
    const distance = Math.hypot(hostilePosition.x - position.x, hostilePosition.z - position.z);
    if (distance > self.props.aggroRadius) continue;
    const seat = parameterNumber(hostile, 'gameplay.seat');
    let committed = 0;
    for (const friend of friends) {
      if (friend.id === ctx.self.id) continue;
      if (parameterNumber(friend, 'gameplay.targetSeat') === seat) committed += 1;
    }
    const score = distance + committed * 9;
    if (score < bestScore) {
      bestScore = score;
      bestId = hostile.id;
      bestSeat = seat;
    }
  }
  self.state.targetId = bestId;
  self.state.targetSeat = bestSeat;
}

/** Light mutual push-off, so ten characters cannot occupy one point. */
function separation(ctx: GameplayContext, self: ScriptSelf, position: { x: number; z: number }): { pushX: number; pushZ: number } {
  let pushX = 0;
  let pushZ = 0;
  for (const neighbour of ctx.world.findByTag('skirmish-combatant')) {
    if (neighbour.id === ctx.self.id) continue;
    const other = neighbour.worldTransform().position;
    const dx = position.x - other.x;
    const dz = position.z - other.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 1.35 || distance < 1e-3) continue;
    const strength = (1.35 - distance) / 1.35;
    pushX += (dx / distance) * strength * 0.9;
    pushZ += (dz / distance) * strength * 0.9;
  }
  return { pushX, pushZ };
}

