# Repository Apply hardening (Phase 11B)

Branch: `claude/edit-rig-scene-controllable-character`
Decision: `DECISIONS/0017-apply-is-enforced-by-the-server.md`

Six gaps were named in `agents/handoffs/route-scoped-editor-finalization.md`
§3.3. All six are closed. Each entry below says what was true before, what it
is now, and which check fails if it regresses.

---

## 1. Runtime request schema

**Before.** `apps/api/src/routes/repository-apply.ts` cast the request body
straight to `SceneOperation[]`. The union existed only in TypeScript, and the
endpoint receives JSON.

**Now.** The union moved to `@atc/schema` (`SceneOperation`, `PlaceableAsset`)
and is registered in `SCHEMA_REGISTRY`; `@atc/editor-core` re-exports the types
so there is one declaration, not two that drift.
`parseSceneOperation` checks the discriminator by hand first — an eleven-member
`anyOf` failure names nothing useful — then validates against the schema. Every
member is `additionalProperties: false`, so a typo'd field is a refusal rather
than a dropped intent. Every operation in a request is parsed before any is
replayed.

**Checks.** `tests/integration/api/repository-apply.test.ts`: unknown type by
name, unknown field, missing required field, non-JSON body. All 400, repository
byte-identical.

## 2 & 3. Server-side protection, and AI approval refusal

**Before.** Only the browser `DocumentEditSession` consulted `evaluateEdit`. A
direct POST edited a locked value.

**Now.** The route evaluates protection against the same gate, the same root
document and the same changed paths as the session, per operation, before
adopting its result. An `actor: 'ai'` request carrying `approved: true` or any
`unlockedPaths` is refused 403 — refused, not ignored, because an ignored field
is indistinguishable from an honoured one. A human's session unlocks travel with
the request (`buildApplyRequest` sends them for `actor: 'human'` only).

**Checks.** Five cases in `server-side protection`: locked path refused with no
browser involved; AI refused on `approval-required`; AI self-approval refused;
AI self-unlock refused; human unlock honoured.

## 4 & 5. Atomic project + report, and fatal read-only transition

**Before.** `saveProject()` then `writeRepositoryReport()` — two `writeFileSync`
calls, two outcomes.

**Now.** Both are `PlannedFileWrite`s handed to the existing
`@atc/repository-transaction` engine — the same journal, write lock,
promotion-by-rename and rollback the animation-asset path already uses, with the
project's sha256 as an optimistic-concurrency expectation re-checked under the
lock. A `fatal` outcome calls `markRepositoryFatal`, so this process refuses
every subsequent write with 503 exactly as the asset path does.

No new transaction package was written. One already existed; the gap was that
Apply did not use it.

**Checks.** The engine's own fault-injection coverage
(`tests/integration/animation-assets/save-destination.test.ts`) and read-only
lockdown coverage (`tests/integration/api/repository-read-only.test.ts`) now
cover this path too, because it is the same path. Apply-specific behaviour is
covered by the 21 cases in `repository-apply.test.ts`.

## 6. Revision identity and no-change behaviour

**Before.** `revisionOf(project)` hashed the whole project *including*
`revisionId`, so the id was a function of the previous id: identical content
reached two ways carried two revisions, and a no-op Apply minted a new one.

**Now.** The hash excludes `revisionId`. A candidate whose content-revision
equals the *recomputed* revision of what is on disk writes nothing, creates no
report, and answers `200 { ok: true, unchanged: true }`. Compared against the
recomputed revision rather than the stored one, so it does not depend on how
whatever wrote the file last computed it.

**Check.** `no-change apply` — success, no write, no `reportPath`, project bytes
unchanged.

## 7. Repeated Apply without reload

**Before.** `acceptApplied(document)` took no revision, and `baseRevisionId` was
`readonly`. The second Apply from an open page declared the baseline the first
Apply had already replaced, and was refused as a conflict with itself. The
handoff called this "the one a user hits first"; it was.

**Now.** `acceptApplied(document, revisionId)` adopts the revision the
repository returned, `baseRevisionId` is a getter over mutable state, and
`use-scene-session.ts` passes `outcome.project.revisionId`.

**Check.** `repeated apply from one session` — apply, accept, edit, apply again;
both 200 and the second change is on disk.

## 8. Undo / redo / stage consistency

**Before.** `undo()` popped the pending entry even when that operation was
already staged (leaving a staged operation nothing could unstage), and `redo()`
did not restore the pending entry at all — so a dispatch/undo/redo round trip
left an edit visible in the preview and absent from the write.

**Now.** Undo unstages an operation it takes back and parks it for redo; redo
restores it *unstaged*, since staging again is a decision the human has not
made. `stagedPathSet` is rebuilt from the operations that remain.

**Checks.** Three cases in `undo, redo and staging agree`, including
`buildStagedDocument()` equalling the preview after an undo and a `stageAll()`.

---

## Suite status after this work

Run on Windows 11, Node 24.18.0, at the tree this report is committed with.

```text
pnpm typecheck                 PASS
pnpm lint                      PASS
pnpm build                     PASS
pnpm harness:check             PASS   5/5
pnpm harness:scenes            PASS
pnpm harness:character-control PASS   22
pnpm harness:capabilities      PASS   5 capabilities
pnpm harness:animation-assets  PASS   7/7
pnpm harness:unit              PASS   437 (+3 new session cases at time of writing)
pnpm harness:integration       PASS   155 (+11 new apply cases at time of writing)
pnpm harness:replay            PASS   129
pnpm harness:repo-guard        PASS   11/11
pnpm harness:world             PASS
```

## Two platform bugs found on the way

Neither is caused by this work; both made the suite unrunnable or red on
Windows, and both are fixed here.

1. **`playwright.config.ts` polled `http://127.0.0.1:5173`.** Vite binds the
   loopback *name*, which resolves to `::1` first on Windows, so the literal
   IPv4 address never reached it and the run died with "Timed out waiting
   90000ms from config.webServer" — the same silent non-start the previous
   handoff observed in its container. Now `localhost`, which is correct on both
   platforms.
2. **`harness/lib.ts` compared CRLF working-tree bytes against LF git blobs**,
   and `harness/repo-guard.ts` compared backslash paths against `packages/…`
   prefixes. Together these reported every published asset as "modified in
   place" and every Simulation-owning package as a control-boundary violation.
   `readRepoFile`/`readAtRevision` now normalize line endings; `listFiles`
   returns forward-slashed paths.

## Visual suite: first execution on real hardware

`pnpm harness:visual` had never produced output before (the previous container
could not start the browser; see §3.1 of the finalization handoff). With the
`localhost` fix above it runs:

```text
144 passed, 3 failed (14.9m)   desktop / mobile-landscape / narrow
```

`tests/visual/scene/scene-authoring.spec.ts` — new on this branch and never
executed by the runner before — **passes on all three projects**.

The three failures are the same test on all three projects:
`animation-assets.spec.ts:172 switching the active character changes which
clips resolve`. Two separate things sit behind it.

1. **A real regression, fixed here.** The library's character `<select>` called
   `setActiveCharacter` directly, but the library is docked *inside* the rig
   editor route, and `RigEditorPage` re-asserts its URL's character whenever the
   store disagrees (DECISION 0012). The control was therefore dead: the store
   switched and was reverted on the next render. It now navigates
   (`rigEditorPath`), which is what the route-scoped model requires. Verified by
   hand in a browser: the URL changes, the store follows, and the `used by
   active character` facet then lists the alternate character's motion set and
   tuning.

2. **An open finding, not fixed.** The test still fails **under the
   Playwright-managed Chromium only**, because *client-side navigation does not
   re-render the route there at all*. `location.pathname` updates and the route
   component keeps rendering the previous character indefinitely (sampled every
   500 ms for 3 s). This is not specific to the select — clicking the rig
   header's plain `<Link>` behaves identically — and it is therefore not caused
   by any change in this work package. In an ordinary browser, driven by hand
   against the same dev server, both the `<Link>` and the select navigate and
   re-render correctly.

   Everything else in the visual suite navigates with `page.goto`, which is a
   full document load, so this is the only test that exercises client-side
   navigation and the only one affected. Worth a focused follow-up (React
   Router v7 + React 18 transitions under that specific Chromium build is the
   most likely direction); it should not be recorded as an application defect
   without reproducing it in a browser a human would use.

**Visual Desktop / Visual 320px are therefore not recorded as PASS.**

## One thing worth a decision, not fixed here

`tests/visual/**` applies edits against the **real repository**, so a visual run
leaves `projects/demo-character/project.json` modified (`/clips/dodge/
rootDisplacement/z = 6.2` in the observed run) and turns `harness:replay` and
`harness:animation-assets` red until the file is restored. That is not a test
failure — it is the visual suite doing exactly what it says — but it means the
visual suite cannot be run before those two harnesses without a
`git checkout -- projects/demo-character/project.json` in between. Pointing the
visual suite at a temporary checkout is the obvious fix and is out of scope for
11B.
