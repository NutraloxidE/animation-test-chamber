# Skill: repo-guardian

## Purpose

Protect what is already good. Verify that a change respects the single source of
truth and the protection levels, and that nothing outside the request moved.

## Inputs

- The working diff (`git diff`, or the staged document from the chamber)
- `projects/*/project.json` at HEAD and in the working tree
- The stated scope of the request

## Outputs

- A Repo Guard report: findings by severity, with canonical paths
- A verdict: safe / needs human decision / blocked

## May change

Nothing. This skill reviews; it does not edit.

## Must not

- Approve removing a setting, fallback, test or error branch on the grounds that
  it is unreferenced, redundant, old-looking or shortenable.
- Accept a test expectation change, a widened tolerance or a relaxed schema
  constraint as a way of making a failure go away.
- Accept edits to anything under `generated/`.

## Checks

1. Did any `locked` or `invariant` value change? Blocking.
2. Was any protection level weakened? Blocking.
3. Were states, transitions, clips, input bindings or haptic bindings removed?
   Blocking.
4. Did a test file lose tests, gain `.skip`/`.todo`, or disappear? Blocking.
5. Did a schema lose `additionalProperties: false`, or make several fields
   optional at once? Blocking.
6. Does any source file import from `generated/`? Blocking.
7. Are there changes outside the requested scope? Report each one.

## Verify

```bash
pnpm harness:repo-guard
pnpm harness:check
```
