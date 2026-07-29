# Skill: git-apply

## Purpose

Take a staged diff from the chamber and land it safely on a working branch.

## Inputs

- The staged document
- The base commit SHA the session started from
- The session id and the human's stated intent

## Outputs

- A commit on `chamber/<project>/<session-id>`
- Optionally a pull request against the protected branch
- On conflict: a per-field conflict list, not a whole-file rejection

## Steps

1. Validate the staged document against the schema and the reference checks.
2. Run the diff policy. A blocking finding stops here.
3. Read the current head. If it differs from the base SHA, do not overwrite —
   convert the clash into per-field conflicts and hand it back to the human.
4. Create the working branch if needed.
5. Write one commit per tuning session, with the changed paths, before/after
   values and the human's intent in the body.
6. Create a pull request if asked.

## Must not

- Commit directly to `main`, or to whatever `GITHUB_PROTECTED_BRANCH` names.
- Commit without a base SHA, or force past a moved head.
- Put a token or private key anywhere the browser can read it.
- Land a commit whose diff contains a blocking finding.

## Verify

```bash
npx vitest run tests/integration
```
