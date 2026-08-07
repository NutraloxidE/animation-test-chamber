# 0028 — Gameplay Script is the typed game extension ABI

Accepted.

Native Components remain a closed discriminated union. One native `script` Component is the stable extension envelope for game rules. Scripts are trusted compile-time TypeScript and canonical JSON stores only an exact versioned gameplay-script reference plus authored properties—never executable text or runtime state. `eval`, `Function`, remote code loading, and runtime module URLs are forbidden.

Script identity is asset id, version, and generated content hash. Unknown ids, versions, hashes, properties, and invalid values are refusals. Discovery and the exact registry are generated, so adding a mechanic requires no central switch. Gameplay state comes from a per-instance factory and runs only on the existing fixed-step clock with deterministic services.

The browser root `/` is the game launch surface. Authoring remains under explicit `/edit/...` routes.
