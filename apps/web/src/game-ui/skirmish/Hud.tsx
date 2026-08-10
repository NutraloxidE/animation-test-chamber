/**
 * The Wildlands Skirmish HUD.
 *
 * Every value shown is projected from the running Scene's Gameplay Script state
 * each frame; this component owns no combat model of its own. What it does own
 * is presentation and *input context*: while a modal is open the player's
 * character is fed a neutral frame, and every confirm is edge-triggered, so one
 * physical press can never buy two potions or spend two level-ups.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeScene } from "@atc/game-object-runtime";
import {
  isPaused,
  publishCameraView,
  readCameraView,
  requestPause,
  suppressGameplayInput,
} from "../game-session.ts";
import { useUiInput, type UiInputEvent } from "./input.ts";
import {
  DIRECTOR_ID,
  ITEM_LABELS,
  LOADOUTS,
  PLAYER_ID,
  SHOP_CATALOG,
  headingLabel,
  readSkirmish,
  type SkirmishView,
} from "./state.ts";

const SHOP_POSITION = { x: 6, z: 34 };
const SHOP_RANGE = 7.5;
const UPGRADES = [
  { id: "hp", label: "Vitality", detail: "Max HP +12" },
  { id: "stamina", label: "Endurance", detail: "Max Stamina +10" },
  { id: "attack", label: "Power", detail: "Attack +4" },
  { id: "defense", label: "Guard", detail: "Defense +2" },
] as const;

/**
 * Pointer activation that does not leave focus behind.
 *
 * The HUD is driven by window-level key handling, so a button that kept focus
 * after a click would also answer the next Enter — which is how one confirm
 * press buys an item *and* re-presses whatever was clicked last.
 */
function click(handler: () => void): (event: { currentTarget: HTMLButtonElement }) => void {
  return (event) => {
    event.currentTarget.blur();
    handler();
  };
}

function bar(value: number, max: number): string {
  return `${Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100))}%`;
}

export function SkirmishHud({ runtime }: { runtime: RuntimeScene }): JSX.Element | null {
  const [view, setView] = useState<SkirmishView | null>(() => readSkirmish(runtime));
  const [shopOpen, setShopOpen] = useState(false);
  const [shopIndex, setShopIndex] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [manualPause, setManualPause] = useState(false);
  const [upgradeIndex, setUpgradeIndex] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const feedbackSeq = useRef(-1);
  const pendingRef = useRef(0);

  /*
   * Read on a slice of the animation frames rather than all of them. The HUD is
   * text at human reading speed, and a full projection of every Script's state
   * sixty times a second buys nothing a player can see while taking time the
   * simulation wants.
   */
  useEffect(() => {
    let frame = 0;
    let count = 0;
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      count += 1;
      if (count % 3 === 0) setView(readSkirmish(runtime));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [runtime]);

  const director = view?.director;
  const player = view?.player;
  const pendingLevelUps = director?.pendingLevelUps ?? 0;
  const levelUpOpen = pendingLevelUps > 0 && !choosing;

  /* A choice already sent must not hold the pause that stops it being applied. */
  useEffect(() => {
    if (pendingLevelUps !== pendingRef.current) {
      pendingRef.current = pendingLevelUps;
      setChoosing(false);
    }
  }, [pendingLevelUps]);

  useEffect(() => {
    requestPause("level-up", levelUpOpen);
    return () => requestPause("level-up", false);
  }, [levelUpOpen]);

  useEffect(() => {
    requestPause("manual", manualPause);
    return () => requestPause("manual", false);
  }, [manualPause]);

  useEffect(() => {
    suppressGameplayInput("menu", shopOpen || levelUpOpen || manualPause);
    return () => suppressGameplayInput("menu", false);
  }, [shopOpen, levelUpOpen, manualPause]);

  useEffect(() => {
    if (!director) return;
    if (feedbackSeq.current < 0) {
      feedbackSeq.current = director.feedbackSeq;
      return;
    }
    if (director.feedbackSeq === feedbackSeq.current) return;
    feedbackSeq.current = director.feedbackSeq;
    setToast({ text: director.feedbackText, key: director.feedbackSeq });
  }, [director]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const nearShop = useMemo(() => {
    if (!player) return false;
    return Math.hypot(player.position.x - SHOP_POSITION.x, player.position.z - SHOP_POSITION.z) < SHOP_RANGE;
  }, [player]);

  useEffect(() => {
    if (!nearShop && shopOpen) setShopOpen(false);
  }, [nearShop, shopOpen]);

  const affordable = SHOP_CATALOG;

  const onUi = (event: UiInputEvent): void => {
    if (!view) return;
    if (levelUpOpen) {
      if (event.action === "up") setUpgradeIndex((index) => (index + UPGRADES.length - 1) % UPGRADES.length);
      else if (event.action === "down") setUpgradeIndex((index) => (index + 1) % UPGRADES.length);
      else if (event.action === "confirm") chooseUpgrade(UPGRADES[upgradeIndex]!.id);
      else if (event.action.startsWith("loadout-")) {
        const slot = Number(event.action.slice(-1));
        if (slot >= 1 && slot <= UPGRADES.length) chooseUpgrade(UPGRADES[slot - 1]!.id);
      }
      /* Nothing else reaches the game while a level-up is open. */
      return;
    }
    if (shopOpen) {
      if (event.action === "up") setShopIndex((index) => (index + affordable.length - 1) % affordable.length);
      else if (event.action === "down") setShopIndex((index) => (index + 1) % affordable.length);
      else if (event.action === "confirm") buy(affordable[shopIndex]?.id);
      else if (event.action === "cancel" || event.action === "interact") setShopOpen(false);
      return;
    }
    switch (event.action) {
      case "interact":
        if (nearShop) {
          setShopOpen(true);
          setShopIndex(0);
        }
        return;
      case "consumable":
        runtime.emit(DIRECTOR_ID, { type: "use-consumable", payload: {} });
        return;
      case "panel":
        setPanelOpen((open) => !open);
        return;
      case "debug":
        setDebugOpen((open) => !open);
        return;
      case "cancel":
        setManualPause((paused) => !paused);
        return;
      case "loadout-next": {
        const current = player?.loadout ?? 0;
        const next = (current + (event.direction === -1 ? LOADOUTS.length - 1 : 1)) % LOADOUTS.length;
        runtime.emit(PLAYER_ID, { type: "set-loadout", payload: { index: next } });
        return;
      }
      default:
        if (event.action.startsWith("loadout-")) {
          const slot = Number(event.action.slice(-1));
          if (slot >= 1 && slot <= LOADOUTS.length)
            runtime.emit(PLAYER_ID, { type: "set-loadout", payload: { index: slot - 1 } });
        }
    }
  };

  useUiInput(onUi);

  function chooseUpgrade(stat: string): void {
    /* Sent once, and the modal closes immediately so the tick that applies it
     * can actually run. The prompt reopens only if another level is pending. */
    setChoosing(true);
    runtime.emit(DIRECTOR_ID, { type: "level-choice", payload: { stat } });
  }

  function buy(itemId: string | undefined): void {
    if (!itemId) return;
    runtime.emit(DIRECTOR_ID, { type: "purchase", payload: { itemId } });
  }

  function debugCommand(action: string, amount: number): void {
    runtime.emit(DIRECTOR_ID, { type: "debug", payload: { action, amount } });
  }

  if (!view || !director) return null;
  const camera = readCameraView();
  const remaining = Math.max(0, Math.ceil((director.matchDurationTicks - director.matchTicks) / 60));
  const threats = player
    ? view.combatants.filter((combatant) => combatant.team === "enemy" && combatant.alive && combatant.threat)
    : [];

  return (
    <div className="skirmish" data-testid="skirmish-hud">
      <div className="skirmish-top">
        <div className="skirmish-compass" data-testid="skirmish-compass">
          <span className="skirmish-compass__strip">
            {[-90, -45, 0, 45, 90].map((offset) => (
              <span key={offset} className={offset === 0 ? "is-center" : ""}>
                {headingLabel(camera.yawRad + (offset * Math.PI) / 180)}
              </span>
            ))}
          </span>
        </div>
        <div className="skirmish-level">
          <span>Lv.{director.level}</span>
          <span className="skirmish-xpbar">
            <span style={{ width: bar(director.xp, director.xpToNext) }} />
          </span>
          <span>{Math.round((director.xp / director.xpToNext) * 100)}%</span>
        </div>
        <div className="skirmish-score" data-testid="skirmish-score">
          <span className="ally">ALLY {String(director.allyScore).padStart(2, "0")}</span>
          <span className="dash">–</span>
          <span className="enemy">{String(director.enemyScore).padStart(2, "0")} RAIDERS</span>
        </div>
        <div className="skirmish-clock">
          Day {director.day} · {director.phase} · {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
        </div>
      </div>

      <div className="skirmish-currency" data-testid="skirmish-currency">
        <span className="coin" />
        {director.currency} scrip
      </div>

      {player && (
        <div className="skirmish-vitals" data-testid="skirmish-vitals">
          <div className="skirmish-loadout">
            {LOADOUTS.map((loadout, index) => (
              <span key={loadout.id} className={index === player.loadout ? "is-active" : ""}>
                {loadout.short}
              </span>
            ))}
            <em>{LOADOUTS[player.loadout]?.label ?? ""}</em>
          </div>
          <div className="skirmish-meter skirmish-meter--hp">
            <span style={{ width: bar(player.hp, player.maxHp) }} />
            <b>
              {Math.ceil(player.hp)} / {player.maxHp}
            </b>
          </div>
          <div className="skirmish-meter skirmish-meter--stamina">
            <span style={{ width: bar(player.stamina, player.maxStamina) }} />
          </div>
          <div className="skirmish-quickslot">
            <span>[K] Field Ration</span>
            <b>×{director.potions}</b>
          </div>
          {!player.alive && (
            <div className="skirmish-respawn" data-testid="skirmish-respawn">
              Respawning in {Math.max(0, Math.ceil(player.downTicks / 60))}
            </div>
          )}
        </div>
      )}

      {threats.length > 0 && (
        <div className="skirmish-threats" data-testid="skirmish-threats">
          {threats.slice(0, 4).map((threat) => {
            const dx = threat.position.x - (player?.position.x ?? 0);
            const dz = threat.position.z - (player?.position.z ?? 0);
            const relative = Math.atan2(dx, dz) - camera.yawRad;
            const distance = Math.hypot(dx, dz);
            return (
              <span
                key={threat.id}
                className="skirmish-threat"
                style={{
                  transform: `rotate(${(relative * 180) / Math.PI}deg) translateY(-46vh)`,
                  opacity: Math.max(0.35, 1 - distance / 28),
                }}
              />
            );
          })}
        </div>
      )}

      {nearShop && !shopOpen && director.matchState === "active" && (
        <div className="skirmish-prompt">[E] Quartermaster</div>
      )}

      {director.bannerTicks > 0 && (
        <div className="skirmish-banner" data-testid="skirmish-banner">
          <strong>DAY {director.day}</strong>
          <span>5 VS 5</span>
          <em>FIGHT</em>
        </div>
      )}

      {toast && <div className="skirmish-toast">{toast.text}</div>}

      {panelOpen && player && (
        <aside className="skirmish-panel" data-testid="skirmish-panel">
          <h2>Loadout</h2>
          <dl>
            <dt>Held</dt>
            <dd>{LOADOUTS[player.loadout]?.label ?? "—"}</dd>
            <dt>Head</dt>
            <dd>{ITEM_LABELS[player.head] ?? "—"}</dd>
            <dt>Chest</dt>
            <dd>{ITEM_LABELS[player.chest] ?? "—"}</dd>
            <dt>Legs</dt>
            <dd>{ITEM_LABELS[player.legs] ?? "—"}</dd>
            <dt>Quick slot</dt>
            <dd>Field Ration ×{director.potions}</dd>
          </dl>
          <h2>Stats</h2>
          <dl>
            <dt>HP</dt>
            <dd>{Math.ceil(player.hp)} / {player.maxHp}</dd>
            <dt>Stamina</dt>
            <dd>{Math.round(player.stamina)} / {player.maxStamina}</dd>
            <dt>Attack</dt>
            <dd>{player.attack}</dd>
            <dt>Defense</dt>
            <dd>{player.defense}</dd>
          </dl>
          <p className="skirmish-allocation">
            HP +{director.upHp} / STA +{director.upStamina} / ATK +{director.upAttack} / DEF +{director.upDefense}
          </p>
          <p className="skirmish-hint">[Tab] close · [1–4] loadout · [K] use ration</p>
        </aside>
      )}

      {shopOpen && (
        <section className="skirmish-modal skirmish-shop" data-testid="skirmish-shop">
          <header>
            <h2>Quartermaster</h2>
            <span>{director.currency} scrip</span>
          </header>
          <ul>
            {affordable.map((entry, index) => {
              const owned = director.owned.includes(entry.id);
              const equipped =
                (entry.slot === "head" && director.equippedHead === entry.id) ||
                (entry.slot === "chest" && director.equippedChest === entry.id) ||
                (entry.slot === "legs" && director.equippedLegs === entry.id);
              return (
                <li key={entry.id} className={index === shopIndex ? "is-selected" : ""}>
                  <button type="button" tabIndex={-1} onMouseEnter={() => setShopIndex(index)} onClick={click(() => buy(entry.id))}>
                    <span className="slot">{entry.slot}</span>
                    <span className="label">{entry.label}</span>
                    <span className="effect">{entry.effect}</span>
                    <span className={director.currency < entry.price ? "price is-short" : "price"}>{entry.price}</span>
                    {equipped ? <span className="tag">equipped</span> : owned ? <span className="tag">owned</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <footer>[↑↓] select · [Enter/A] buy &amp; equip · [E/Esc] leave</footer>
        </section>
      )}

      {levelUpOpen && (
        <section className="skirmish-modal skirmish-levelup" data-testid="skirmish-levelup">
          <header>
            <h2>Level {director.level}</h2>
            <span>Choose one</span>
          </header>
          <ul>
            {UPGRADES.map((upgrade, index) => (
              <li key={upgrade.id} className={index === upgradeIndex ? "is-selected" : ""}>
                <button type="button" tabIndex={-1} onMouseEnter={() => setUpgradeIndex(index)} onClick={click(() => chooseUpgrade(upgrade.id))}>
                  <span className="label">{upgrade.label}</span>
                  <span className="effect">{upgrade.detail}</span>
                </button>
              </li>
            ))}
          </ul>
          <footer>
            Current: HP +{director.upHp} / STA +{director.upStamina} / ATK +{director.upAttack} / DEF +{director.upDefense}
          </footer>
        </section>
      )}

      {director.matchState !== "active" && (
        <section className="skirmish-modal skirmish-result" data-testid="skirmish-result">
          <h2 className={`is-${director.result || "draw"}`}>{(director.result || "draw").toUpperCase()}</h2>
          <dl>
            <dt>Score</dt>
            <dd>
              {director.allyScore} – {director.enemyScore}
            </dd>
            <dt>Your KOs</dt>
            <dd>{director.playerKos}</dd>
            <dt>Assists</dt>
            <dd>{director.playerAssists}</dd>
            <dt>Scrip earned</dt>
            <dd>{director.currencyEarned}</dd>
            <dt>Level reached</dt>
            <dd>{director.level}</dd>
          </dl>
          <footer>Next day starting…</footer>
        </section>
      )}

      {manualPause && !levelUpOpen && (
        <section className="skirmish-modal skirmish-paused" data-testid="skirmish-paused">
          <h2>Paused</h2>
          <footer>[Esc] resume</footer>
        </section>
      )}

      {debugOpen && (
        <aside className="skirmish-debug" data-testid="skirmish-debug">
          <h2>Debug</h2>
          <p>
            gen {director.generation} · {director.matchState} · tick {director.matchTicks}/{director.matchDurationTicks} ·{" "}
            {director.phase}
          </p>
          <p>
            teams {director.aliveAllies}/{director.aliveEnemies} · score {director.allyScore}-{director.enemyScore} · pickups{" "}
            {director.pickupCount} · paused {String(isPaused())}
          </p>
          {player && (
            <p>
              player hp {Math.ceil(player.hp)}/{player.maxHp} sta {Math.round(player.stamina)} atk {player.attack} def{" "}
              {player.defense} · {player.loadoutId} · {player.head || "—"}/{player.chest || "—"}/{player.legs || "—"}
            </p>
          )}
          <p className="skirmish-debug__ai">
            {view.combatants
              .filter((combatant) => !combatant.isPlayer)
              .slice(0, 5)
              .map((combatant) => `${combatant.id.replace("skirmish-", "")}:${combatant.aiState}`)
              .join(" · ")}
          </p>
          <div className="skirmish-debug__actions">
            <button type="button" tabIndex={-1} onClick={click(() => debugCommand("xp", 60))}>
              +XP
            </button>
            <button type="button" tabIndex={-1} onClick={click(() => debugCommand("currency", 100))}>
              +scrip
            </button>
            <button type="button" tabIndex={-1} onClick={click(() => debugCommand("ko-player", 0))}>
              KO me
            </button>
            <button type="button" tabIndex={-1} onClick={click(() => debugCommand("coin", 4))}>
              drop coin
            </button>
            <button type="button" tabIndex={-1} onClick={click(() => debugCommand("advance", 60))}>
              +60s
            </button>
            <button type="button" tabIndex={-1} onClick={click(() => debugCommand("end-match", 0))}>
              end match
            </button>
          </div>
          <ol className="skirmish-debug__log">
            {director.log
              .slice(-8)
              .reverse()
              .map((entry) => (
                <li key={`${entry.tick}-${entry.kind}-${entry.text}`}>
                  <b>{entry.kind}</b> {entry.text}
                </li>
              ))}
          </ol>
        </aside>
      )}
    </div>
  );
}

export { publishCameraView };
