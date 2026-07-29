# Skill: animation-acquisition

## Purpose

Turn a needed motion into a project asset whose origin and rights are traceable,
which is normalized, retargeted, validated, and tunable from the chamber.

## Inputs

- A natural-language motion request
- The source file, or the provider to obtain it from
- Licence terms as stated by the source

## Outputs

- A Motion Brief
- An asset provenance record and licence manifest
- A registered candidate, with its validation issues listed

## Pipeline

```text
acquire → verify provenance and licence → import → analyze skeleton
→ map to canonical humanoid → normalize axes, scale, FPS → retarget
→ extract or remove root motion → detect loop and foot contacts
→ detect spikes, sliding and penetration → register as Candidate
→ human compare → human accept → commit manifest and metadata
```

## Must not

- Depend on an unofficial or unpublished API of any service. Automate from
  *import* onward; obtaining the file is the human's step.
- Mark an unknown licence field as allowed. `unknown` is treated exactly like
  `forbidden`, and blocks committing the raw asset.
- Replace an existing clip before the candidate reaches `HumanAccepted`, and
  never replace a protected clip automatically.
- Add a raw asset to a public repository without a human-verified manifest.

## Asset states

`Imported → Candidate → Retargeted → Validated → HumanAccepted → Registered`,
with `Rejected` reachable from any of them. Only a human may set `HumanAccepted`.

## Verify

```bash
npx vitest run tests/unit/acquisition.test.ts
pnpm harness:repo-guard
```
