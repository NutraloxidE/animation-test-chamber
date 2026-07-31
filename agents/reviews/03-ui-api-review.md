# 03 — UI, API and security review

Reviewer: main agent (Opus 5) in the architecture-and-audit role.

## Server trusts nothing from the browser

Every write endpoint in `apps/api/src/routes/animation-assets.ts` re-runs the
whole chain server-side: schema validation, content-hash verification,
published-version immutability, dependency resolution for **every** character,
and the diff policy. The browser's opinion is never an input to the decision.

`runAssetTransaction` validates the repository *as it would be* — assets on disk
plus the proposal — rather than the proposal alone. A new version that is
internally fine and breaks the character referencing it is exactly the failure
this catches, and checking the proposal in isolation would miss it.

`/api/animation-assets/publish` derives the version itself and ignores any
version in the request. A caller asking to publish over `1.0.0` is asking to
rewrite history; the answer is always "here is `1.0.1`".

## Draft versus published

Nothing in the browser can write. The store's write paths all go through the
API, and on a static host they short-circuit into preview-only behaviour with an
explicit reason rather than a failed fetch.

## Save destination is never implicit

`saveDestinationOptions()` returns five destinations, each with its blast radius
computed from the actual project — "All 2 characters on `humanoid-third-person-base`",
not a generic warning. No option is preselected, `chosen` starts `null`, and the
submit button is disabled until a human picks one. Asserted by
`tests/visual/animation-assets.spec.ts`, which walks every radio and requires all
of them unchecked.

`commit()` refuses to proceed when staged changes include animation paths, and
opens the dialog instead. Committing them into `project.json` would be the
destination decision taken silently — the one thing plan §12.5 forbids.

Unavailable destinations are shown disabled with the reason ("this character has
no tuning profile") rather than hidden. A shorter list teaches nothing.

## Reference updates stay explicit

The shared-behaviour destination publishes a new behaviour version and re-points
**only** the character that made the edit. Plan §12.4 is explicit that a
reference never moves on its own; the other characters keep pointing at the
version they were verified against.

## Static mode degrades explicitly

`AssetActions` disables every write with the reason on the button. The library
still browses, searches, previews, shows dependencies, compares versions and
applies assets for preview, because the generated index carries whole asset
documents and the browser runs the same resolver the server does.

## Security

No new secret surface. The asset endpoints read and write inside the repository
only; `assetFilePath` is a total function over a closed union of asset types and
`Id`-validated ids, so a request cannot address a path outside `assets/animation/`.
The repo guard's secret scan and the web-bundle credential check both still pass.

## Findings requiring follow-up

The Motion Set Editor's clip picker currently reports what a rebinding *would*
do rather than performing it — rebinding is routed through Publish. That is a
deliberate scope boundary, not a defect, but it does mean the plan's "each row
can change its clip" is only partially delivered. Recorded in
`05-final-acceptance.md`.
