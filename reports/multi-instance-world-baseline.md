# Multi-instance world — baseline

What the repository looked like before this work package, recorded so the
"after" numbers mean something.

## Base

- SHA: `c684dafb1ceadc252ab9621674c32e32d117bcf7`
- Branch: `main`
- Worktree: clean

## Test counts before

| Suite | Files | Tests |
| --- | --- | --- |
| unit + integration + replay (vitest) | 22 | 452 |
| visual (playwright, 3 projects) | 2 | 114 |

## Harness stages before

`static` (typecheck, lint, schema drift, dead references, generated-not-canonical),
`animation assets`, `transaction recovery`, `unit`, `integration`, `replay`,
8 × repo guard, `build`, `visual`.

## Single-instance assumptions inventoried

Recorded in full in `agents/reviews/06-multi-instance-architecture-audit.md`.
The short version: `activeCharacterId` chose one character, `ChamberEngine`
owned one `Simulation`, the viewport rendered one `<Character>`, replay frames
and tick records carried no instance identity, and inspector paths addressed the
focused character implicitly.

The one piece of good news that shaped everything after it: `Simulation` was
already a self-contained unit of mutable character state with no module-level
state and no singletons. A multi-instance world therefore needed to decide
*which* simulations exist and in what order they tick — not to reimplement a
state machine.

## What was deliberately not measured

Wall-clock performance. The world runs N simulations where it used to run one,
and nothing here establishes how many instances is too many. The acceptance
fixture uses two and the visual suite drives them at 320px without trouble; that
is the extent of the evidence.
