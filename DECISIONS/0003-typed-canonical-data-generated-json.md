# 0003 — Typed TypeScript is canonical; JSON views are generated

Status: accepted

## Context

The plan lists both `presets/` and `schemas/` as repository contents. Hand-edited
JSON with no type checking is exactly the kind of second copy that drifts — the
problem SSoT is meant to eliminate.

## Decision

- **Terrain presets** are authored as typed TypeScript in
  `packages/terrain-runtime/src/presets.ts`. The compiler enforces the schema at
  author time.
- **JSON Schemas** are generated from the TypeBox definitions.
- Both JSON views are emitted by `pnpm schema:generate` into `presets/terrain/`
  and `schemas/`, for consumers without a TypeScript toolchain (notably the
  Unity bundle).
- `pnpm harness:check` regenerates both in memory and fails if the committed
  files differ, so the views cannot silently drift or be hand-edited.

The project itself (`projects/demo-character/project.json`) is the exception: it
is canonical JSON, because it is the artifact humans and AI edit *through the
app* and commit. `harness/seed-demo-project.ts` is a one-time seed tool, not a
generator; it refuses to overwrite without `--force`.

## Consequences

- Editing `presets/terrain/*.json` or `schemas/*.json` by hand fails the harness.
- Adding a terrain preset means editing typed TypeScript and regenerating.
