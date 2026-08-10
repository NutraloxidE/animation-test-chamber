/**
 * The game's own overlay surface.
 *
 * The play host mounts this and hands it the running Scene. Which game is
 * running is decided *here*, by asking the Scene what it contains — the host
 * stays a host, and adding a second game later means adding a branch in this
 * file rather than in the runtime.
 */
import type { RuntimeScene } from "@atc/game-object-runtime";
import { SkirmishHud } from "./skirmish/Hud.tsx";
import { hasSkirmish } from "./skirmish/state.ts";

export function GameOverlay({
  sceneName,
  runtime,
}: {
  sceneName: string;
  runtime?: RuntimeScene | null;
}): JSX.Element {
  const skirmish = hasSkirmish(runtime ?? null);
  return (
    <section className="game-overlay" data-testid="game-overlay" aria-live="polite">
      {skirmish && runtime ? <SkirmishHud runtime={runtime} /> : <span>{sceneName}</span>}
    </section>
  );
}
