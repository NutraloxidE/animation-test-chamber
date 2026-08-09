# Gameplay Vibe-Coding Platform Handoff

Final SHA: use `git rev-parse HEAD` on branch `codex/gameplay-vibe-coding-platform`.

New mechanics go in `packages/gameplay/src/scripts/<id>/<version>.ts`. Add a script, run `pnpm gameplay:generate && pnpm harness:gameplay`, then publish a new Prefab version with an exact Script Component reference. Upgrade behavior by adding a new immutable script version and explicitly adopting a new Prefab/Scene version; never edit referenced source in place.

The game HUD seam is `apps/web/src/game-runtime/PlayScenePage.tsx`. Play routes are `/` and `/play/:sceneId`; authoring routes are `/edit/scene/:sceneId`, `/edit/prefab/:prefabId`, and the exact animation workspace below the Prefab route.

Use a native Component only for a reusable engine capability. Ordinary mechanics must not alter the core Component union, runtime registry, router, or Inspector registration.

Commands: `pnpm gameplay:generate`, `pnpm gameplay:check`, `pnpm harness:gameplay`, `pnpm harness:play-surface`, `pnpm harness:vibe-coding`, then the repository one-shot.

Known limit: the game overlay is intentionally a small host seam; this WP does not add an in-browser gameplay source editor.

Closure status: platform-focused gates pass; overall audit remains HOLD because legacy chamber visual expectations still target deleted Character-bound UI. Do not restore those adapters merely to satisfy the stale assertions.
