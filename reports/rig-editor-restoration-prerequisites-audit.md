# Rig Editor restoration prerequisites audit

## Revisions

- Remote pre-work SHA: `0e74422784b1a41a3ca3bfaaacc19dc62e82ebf6`
- Checkpoint SHA: `b467ba465029332f9192b6f24caa1dfad1971434`
- Implementation SHA: `6fd64220e1a627b4f7e0fdb358566bfb8ab49a50`
- Closure documentation SHA: `54dd2930227f0b6ec71452eef2802dc5c3df357e`
- Refusal-coverage SHA: `e144862` (see "Gap closed" below)
- Verified head SHA: `b6976f0e48b609f048fff10dfd1080f7fcea2359`, superseded by the run pair at `e144862`
- `origin/main` tip: `2e5b2a21a269f41aad7f14c00b0cded91233f33f`
- Canonical Project Git blob before/after verification: `8730866dec007ab77fa8bb035053d5e1b747cf0b`

The working checkout is a shallow clone (51 commits). `git merge-base` therefore
returns no common ancestor with `origin/main`, and the `origin/main` tip is not
present in this branch's truncated history. An earlier revision of this audit
recorded `2e5b2a21…` as the merge base; that value is not verifiable here and is
recorded above as the `origin/main` tip only.

The WIP checkpoint was pushed before closure work. The implementation commit was tested from a clean tree. No `.chamber-transactions` directory remained after either official run.

## Exact adoption matrix

Every cell is an individual parameterized integration test in `tests/integration/api/prefabs.test.ts`, named `adopts <derivation> × <slot> through stored files and the real resolver`.

That title previously stored the multiplication sign as its UTF-8 bytes decoded
as Latin-1, so each cell reported as `adopts base Ã— behavior`. Repaired in
`b6976f0e48b609f048fff10dfd1080f7fcea2359`; assertions were not touched.

| Prefab derivation | behavior | motionSet | rig | tuning |
| --- | --- | --- | --- | --- |
| base | PASS | PASS | PASS | PASS |
| fork | PASS | PASS | PASS | PASS |
| variant | PASS | PASS | PASS | PASS |

Command: `pnpm harness:prefab-api`

Result: 24/24 tests passed. For each matrix cell the test creates deterministic stored files, records old animation/Prefab/non-target/Project/variant-parent bytes, calls the real HTTP route, reloads both new versions from disk, resolves the new Prefab, locates `animated-child/target-animator`, and proves only the selected exact slot changed. It verifies the published animation and Prefab hashes against stored bytes and both generated indexes. Every recorded old/non-target/Project/parent byte string remains identical.

Source reference hashes exercised:

- behavior `humanoid-third-person-base@1.0.0`: `0658a240431284d7ec50e8bf9d93d00c683009cd7adadf0aab37906d7ca58c66`
- motion set `demo-humanoid-motion-set@1.0.0`: `973c67a41ed1ee36ea096111e8a84d00c15a3ba48372884b1ed28108541b750c`
- rig `demo-humanoid-rig@1.0.0`: `2f8c7909d85613f6872337d287261ea1f4ef5a43649be0c5a270736bb6d91f6d`
- tuning `demo-default-tuning@1.0.0`: `9fe8797c590e5d01491417e7b56e992e6ae7ff3b2b5bb1efc539f7d411a82187`

The matrix caught a real defect: `assignmentPath()` compared type/id/version but not `contentHash`. It now requires the complete exact reference. Each fixture contains two Animators; the stale-hash Animator remains byte-for-byte unchanged.

## Variant, fork, nesting and changed-target evidence

- Fork tests prove the same lineage receives a new immutable version and its origin remains unchanged.
- Variant fixtures begin with an existing terminal assignment patch plus an unrelated `/enabled` patch. Publication leaves one terminal assignment patch, preserves the unrelated patch, sorts deterministically, remains `derivation.mode = variant`, stores no `root`, and leaves the parent unchanged.
- Stored-root rewriting recurses only through inline children. Nested Prefab references are not rewritten or flattened.
- `changedTargets.prefabIds` is derived from successful transaction `changedPaths` matching promoted `assets/prefabs/<id>/<version>.json` paths. Every matrix cell asserts that response set equals the sole new Prefab file and target lineage.

## Publication, refusal and transaction evidence

- Publish-only is covered by `publishes the animation and moves zero Prefabs when the target list is empty`; the Prefab index and Project remain unchanged.
- Exact target, stale holder snapshot, stale revision, unknown target, immutable publication collision, prepared-write failure, promotion rollback, fatal rollback and recovery are covered by the Prefab/API and repository transaction suites.
- `tests/integration/api/repository-apply-faults.test.ts`: 16/16 passed in the final isolated run.
- Windows fault selectors normalize only their predicate input; the production transaction seam retains native absolute paths, preserving all transaction ownership tests.
- Publication plans expose exact current holders, selected targets, non-targets, protected targets and deterministic expected writes. The closed request schema refuses wildcard scope fields.

### Gap closed: refusal coverage in the animation-to-Prefab direction

An earlier revision of this audit claimed the refusal cases were covered "by the
Prefab/API and repository transaction suites". Re-reading the suites by test name
rather than by that claim showed the coverage was asymmetric: the parameterized
refusal cases (`refuses %s with zero writes`) existed only for the
Prefab-to-Scene route. The animation-to-Prefab route asserted one refusal, the
stale holder snapshot, which left four reachable branches proven by nothing:

| Branch | Source |
| --- | --- |
| stale source content hash | `adoption.ts:125` |
| stale project revision | `adoption.ts:131` |
| unknown target | `adoption.ts:163` (`unknown-target`) |
| target does not hold the source | `adoption.ts:163` (`target-does-not-hold-source`) |
| protected target | `routes/prefabs.ts:906` |

Five tests now cover them in `tests/integration/api/prefabs.test.ts`. Each takes
a SHA-256 digest over every file under `assets`, `generated` and `projects`
before the request and requires it unchanged after, so a refusal that wrote or
rewrote any byte fails — a file-list comparison alone would miss an in-place
rewrite. `pnpm harness:prefab-api` is 29/29 and integration moved from 289 to
294.

Both new mechanisms were mutation-tested rather than assumed:

- Replacing the protection guard with `if (false)` made the route publish four
  paths and failed `refuses a protected target with zero writes` at the status
  assertion.
- Allowing that mutated run to reach the digest comparison failed it there too
  (`be249250…` against `3c0d6edb…`), which is the proof that the digest observes
  writes rather than returning a constant.

Both mutations were reverted; `apps/api/src/routes/prefabs.ts` is byte-identical
to its committed state.

## Subject and compatibility evidence

- Closed `AnimationSubjectDefinition` names exact Prefab, node and Animator Component identity.
- `animationSubjectFromPrefab` never falls back to the first node or Animator and permits graph editing without presentation.
- `resolveAnimationSubject` and the legacy wrapper share one assignment resolver.
- Session construction owns disposal and carries subject-specific presentation separately from immutable bundles.
- The embedded Prefab Animator workspace starts from the explicit subject. The legacy Character projection is isolated in `legacy-animation-workspace-adapter.ts`.
- `/edit/rig/:id` remains a redirect. No Rig Editor UI or legacy schema was restored or deleted.

## Full verification (previous session, Windows)

Recorded before the refusal gap was closed, which is why the Prefab API count is
24 and integration is 289 here; both are higher in the re-verification below.

Focused command matrix results:

- typecheck: PASS
- lint: PASS
- build: PASS
- animation assets: 7/7 PASS
- Prefabs: 6/6 PASS
- Prefab API: 24/24 PASS
- GameObjects: 3/3 PASS
- renderer: 5/5 PASS
- Scene cutover: 10/10 PASS
- rig prerequisites: 3/3 PASS
- character control: 22/22 PASS
- unit: 722/722 PASS
- integration: 289/289 PASS in the official runs
- replay: 129/129 PASS
- Repo Guard: 14/14 PASS

Full visual command: `pnpm harness:visual`

- 249 configured cases across desktop, mobile-landscape and narrow.
- 243 passed; 6 skipped. No test was removed, disabled or newly skipped for this work.

The 6 skips are two `test.fixme` placeholders in
`tests/visual/routing/prefab-binding.spec.ts:172-173` (`the Prefab Overview names
every reference and who else holds it`, `the preview override is visibly
non-canonical, and resets on navigation`), counted once per browser project.
Both were introduced by `fdfe70a` — "Give a Prefab its own route, and make the
rig route a redirect" — which precedes the checkpoint `b467ba4`, so neither was
added by this work. An earlier revision of this audit described them as
"project-conditioned skips"; they are unimplemented placeholders multiplied
across the three projects, which is the accurate description. The one genuinely
project-conditioned guard, `apply-round-trip.spec.ts:31`, skips only outside the
wrapper; under `pnpm harness:visual` those tests ran.
- Duration: 17.4 minutes in the standalone proof.
- Wrapper reported `source checkout unchanged; disposable repository removed`.
- Windows launch was repaired by using the command shell for `npx`; the full suite then completed normally with no port, process or transaction-lock residue.

Official one-shot run 1:

- Clean start: PASS
- Result: 62/62 stages PASS
- Total: 1,199.6 seconds
- Visual: PASS, 1,061.7 seconds
- Clean afterward: PASS

Official one-shot run 2, immediately after run 1 with no cleanup:

- Clean start: PASS
- Result: 62/62 stages PASS
- Total: 1,174.2 seconds
- Visual: PASS, 1,039.8 seconds
- Clean afterward: PASS

## Independent re-verification at `b6976f0`

The results above were recorded on Windows. Every gate was re-run from a clean
tree on Linux at `b6976f0e48b609f048fff10dfd1080f7fcea2359`, from a fresh
`pnpm install --frozen-lockfile`, rather than carried over from that session.

| Gate | Command | Result |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | PASS |
| lint | `pnpm lint` | PASS |
| build | `pnpm build` | PASS |
| adoption matrix + refusals | `pnpm harness:prefab-api` | 29/29 PASS |
| transaction faults | `npx vitest run tests/integration/api/repository-apply-faults.test.ts` | 16/16 PASS |
| animation assets | `pnpm harness:animation-assets` | 7/7 PASS |
| Prefabs | `pnpm harness:prefabs` | 6/6 PASS |
| GameObjects | `pnpm harness:game-objects` | 3/3 PASS |
| renderer | `pnpm harness:game-object-renderer` | 5/5 PASS |
| Scene cutover | `pnpm harness:scene-gameobject-cutover` | 10/10 PASS |
| rig prerequisites | `pnpm harness:rig-editor-prerequisites` | 3/3 PASS |
| world | `pnpm harness:world` | PASS |
| Repo Guard | `pnpm harness:repo-guard` | 14/14 PASS |
| unit | `pnpm harness:unit` | 722/722 PASS |
| integration | `pnpm harness:integration` | 294/294 PASS |
| replay | `pnpm harness:replay` | 129/129 PASS |

Generation drift: `pnpm schema:generate` wrote 70 files with
`git diff --exit-code -- schemas` clean; `pnpm assets:animation:index` (149 asset
versions, index hash `efc894ace4c9`), `pnpm assets:prefabs:index` and
`pnpm prefabs:check` (7 Prefabs, 5 migrated identities already current) left the
tree clean. Zero drift on all three.

Standalone visual proof: `pnpm harness:visual` — 243 passed, 6 skipped of 249
configured, 17.1 minutes, single worker, exit 0. The wrapper reported
`source checkout unchanged; disposable repository removed`, and
`git status --short` was empty afterwards. No port, process or transaction-lock
residue.

An initial pair of official runs passed 62/62 at `b6976f0` (1,062.0s and
1,036.1s). Closing the refusal gap changed test code afterwards, so that pair no
longer described the final tree and the official count was restarted at
`e144862` rather than carried forward.

Official one-shot run 1, from a clean tree at `e144862`:

- Clean start: PASS (`git status --short` empty)
- Result: 62/62 stages PASS, exit 0
- Total: 1,350.2 seconds; visual stage 1,270.1 seconds
- `prefab API` (7.8s, 29 tests) and `rig prerequisites` present as explicit stages
- Clean afterward: PASS

Official one-shot run 2, immediately after run 1 with no manual cleanup:

- Clean start: PASS
- Result: 62/62 stages PASS, exit 0
- Total: 1,329.5 seconds; visual stage 1,257.0 seconds
- Clean afterward: PASS

Run 2 required no cleanup after run 1, which is the idempotent-generation,
process-cleanup and repository-isolation proof.

RIG EDITOR RESTORATION PREREQUISITES: PASS

READY FOR RIG EDITOR UI RESTORATION
