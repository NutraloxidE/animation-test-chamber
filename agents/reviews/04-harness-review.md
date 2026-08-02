# 04 — Harness and repo guard review

Reviewer: main agent (Opus 5) in the architecture-and-audit role.

## New stages

`harness/check-animation-assets.ts` adds seven stages, ordered so that a failure
names a cause rather than a symptom:

1. **assets resolve and validate** — every reference resolves, every hash
   matches, every asset is schema-valid.
2. **every character resolves** — both characters produce a runnable document.
3. **generated index is current** — rebuilt and compared byte-for-byte. A stale
   index is the one failure a static host cannot detect for itself.
4. **migration is deterministic** — run twice, compared. A wall-clock timestamp
   anywhere would move every content hash on every run.
5. **shadow runtime** — 9/9 replays identical to the pre-migration runtime.
6. **shared behaviour** — two characters, identical sequencing, no shared clip.
7. **second character replays** — every fixture runs to completion for it.

These run **before** the unit tests in `harness:one-shot`, so a broken reference
does not present as thirty confusing test failures.

## Repo guard additions

**`publishedAssetImmutabilityStage`** — every `assets/animation/**.json` present
at HEAD must be byte-identical now. New version files are always allowed;
changing or deleting an existing one never is.

**`stateNameDependenceStage`** — six patterns, checked against
`animation-runtime`, `replay-runtime` and `terrain-runtime` with comments
stripped first, so the comments explaining what was removed are not themselves
violations. Panels are excluded: naming a state for display is legitimate.

## One guard was repaired, not relaxed

`protectedValuesStage` compares `project.json` at HEAD against the working tree.
Across the v1→v2 split those two files are not comparable — the clips and graph
moved into assets, so a naive diff reported all 35 clips as deleted when none had
gone anywhere.

The fix diffs against the **resolved** document when the schema version differs.
This is stricter, not weaker: a clip that genuinely vanished during the migration
would still be missing from the resolved document and would still fail. Skipping
the stage, or filtering out `clip-removed`, would have been the weakening — and
both were available and rejected.

## Test integrity

No test was deleted or skipped. Test count moved 245 → 246 in the pre-existing
files (one added to `diff-policy.test.ts` for the new unbound-slot rule), plus
106 new tests across four new files. Tests whose assertions were about
`state.clipId` or `weaponClips` were rewritten to make the *same* assertion
through the new model — for example "every catalog weapon mode has its own attack
clips" now asks the bindings instead of a map on the state, and still requires
all six clips to be distinct.

## Gate E findings

See `05-final-acceptance.md`. The harness does not pass end to end, for reasons
that predate this work.
