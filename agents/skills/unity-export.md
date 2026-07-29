# Skill: unity-export

## Purpose

Produce the Unity bundle and adapter scaffold from canonical data.

## Inputs

- The canonical project
- The replay fixtures

## Outputs

`generated/unity/` containing project/graph/input/movement/terrain/haptic JSON,
replays, an asset manifest carrying licence terms, generated C# DTOs, the
adapter runtime, the editor menu item, and a README stating the limitations.

## Must not

- Treat anything under `generated/` as canonical, or import from it.
- Let a Unity-side edit flow back into canonical data without an explicit
  import-back path. There is none in the MVP; the browser is the source.
- Claim Animator Controller parity. The adapter drives its state machine from
  JSON at runtime, and the generated README says so.
- Silently drop licence metadata from the asset manifest.

## Notes

C# DTOs are generated from the same TypeBox schemas the web app validates
against, so the two cannot drift. Discriminated unions are flattened with a
`kind` discriminator because Unity's `JsonUtility` cannot express polymorphism —
this is stated in the generated header, not hidden.

## Verify

```bash
pnpm unity:export
npx vitest run tests/integration
pnpm harness:check
```
