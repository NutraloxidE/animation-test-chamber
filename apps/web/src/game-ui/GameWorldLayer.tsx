/**
 * The in-canvas counterpart to `GameOverlay`.
 *
 * Same rule: the host mounts one generic layer, and this file decides what the
 * running Scene needs. A Scene with no game in it renders nothing at all, which
 * is why the play host can carry this unconditionally without knowing that
 * Wildlands Skirmish exists.
 */
import type { ReactNode } from "react";
import type { EquipmentSocketDefinition } from "@atc/schema";
import type { RuntimeScene } from "@atc/game-object-runtime";
import { SkirmishWorldLayer } from "./skirmish/WorldLayer.tsx";
import { renderSkirmishAttachment } from "./skirmish/attachments.tsx";
import { hasSkirmish, readSkirmish } from "./skirmish/state.ts";

export function GameWorldLayer({ runtime }: { runtime: RuntimeScene }): JSX.Element | null {
  return hasSkirmish(runtime) ? <SkirmishWorldLayer runtime={runtime} /> : null;
}

/**
 * Fills authored equipment sockets from authoritative game state.
 *
 * Returned as a function of the Scene so the host can hand one prop to the
 * renderer without importing any game's vocabulary. Reading state per socket
 * rather than caching a frame's worth is deliberate: a socket that drew last
 * frame's helmet after an equip would be exactly the visible half-state the
 * atomic-equip rule exists to prevent.
 */
export function gameSocketAttachments(
  runtime: RuntimeScene | null,
): ((input: { gameObjectId: string; socket: EquipmentSocketDefinition }) => ReactNode) | undefined {
  if (!runtime || !hasSkirmish(runtime)) return undefined;
  /* One read for the whole frame; the caller re-derives this per frame. */
  const view = readSkirmish(runtime);
  if (!view) return undefined;
  const byId = new Map(view.combatants.map((combatant) => [combatant.id, combatant]));
  return ({ gameObjectId, socket }) => renderSkirmishAttachment(byId.get(gameObjectId), socket);
}
