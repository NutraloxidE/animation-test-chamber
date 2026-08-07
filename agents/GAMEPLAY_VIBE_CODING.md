# Gameplay Vibe Coding

Game rule = Gameplay Script. Engine capability = native Component.

Put ordinary mechanics in `packages/gameplay/src/scripts/<id>/<version>.ts` and define them with `defineGameplayScript`. Use descriptor properties for canonical tuning and a `state` factory for per-instance mutable values. Run `pnpm gameplay:generate` and `pnpm harness:gameplay`, then attach the exact generated id/version/hash through a Script Component in a new Prefab version.

Never use wall clocks, browser globals, `Math.random`, mutable module state, executable JSON, a manual registry switch, or canonical fields for runtime state. Use `ctx.deltaSeconds`, `ctx.random()`, deferred events, and queued world mutations.

Only add a native Component for reusable engine capabilities such as audio playback. That rare path requires schema, semantic validation, runtime, renderer/host where applicable, Inspector, export where applicable, tests, harness, and an architectural decision when warranted.
