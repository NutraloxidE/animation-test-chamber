# 0011 — Capability completeness contract

## Status

Accepted.

## Context

This repository's stated value is that a later agent — human or machine — can
compose something from reusable definitions and verify the result without
inventing a new integration path each time. That only holds if every capability
is reachable four ways: a machine can operate it, a human can author it,
something can observe what it did, and a test can prove it deterministically.

Historically, new capabilities arrived with some subset. A feature with a
runtime and a panel but no observation is invisible to an agent; one with a
command and no test is a claim.

## Decision

A capability declares itself in a `CapabilityManifest`, and
`harness:capabilities` fails the build when the declaration is incomplete or
points at something that does not exist.

The rule the manifest exists to enforce:

> A new runtime capability is incomplete if it has no machine path, no human
> authoring path, no observation path, or no deterministic verification path.

All four are required non-empty fields, and the harness additionally rejects: an
authoring field backed by a command nobody implemented, a field reading an
observation nobody emits, a fixture path that does not exist, a harness stage
naming an absent npm script, a schema id absent from `SCHEMA_REGISTRY`,
duplicate command or surface ids, and a command missing either schema.

`tests/unit/capabilities/capability-registry.test.ts` breaks each of those
deliberately and asserts the failure. Without those, the checker could return an
empty list for every input and the suite would stay green.

Two capabilities are registered: `world.multi-instance` and a small
`world.intent-tracks`. The second exists so the rules are exercised against a
capability they were not written for — a registry with one member is
indistinguishable from a hard-coded special case.

## Commands, and the one that does not exist

Commands are typed, validated by the registry against their declared input
schema before running, and return structured issues rather than throwing.
Mutating commands return a **proposed** `WorldDefinition` and the canonical
paths it touches; publishing stays on the existing validated save/transaction
path. No command is handed a filesystem, a git adapter or a transaction.

There is deliberately **no `apply_patch(path, value)`**. A general
"edit arbitrary canonical JSON" command would make every other guarantee here
unenforceable — protection, validation, the definition/instance boundary —
because a caller could reach past all of them through one hole and nothing would
be able to tell that it had. A test asserts no command input schema accepts
`path`, `patch` or `value`.

The browser uses the same commands. The world panel's instance controls are
rendered *from* the authoring surface declaration — labels, ranges and step
sizes come from the manifest, and each control dispatches the `commandId` the
manifest names. That is what makes "a declared field with a missing command
fails the harness" a statement about the running UI rather than about a document
nobody reads. It is not a generic property editor, and the existing Inspector is
not built from it: a universal property editor is a much larger thing to be
wrong about.

## Read-only mode

Discovery and observation are GET and stay available when the repository has
gone read-only — those are the tools an operator reaches for *because*
something is wrong. Command execution is POST, and the read-only middleware
exempts commands the registry reports as non-mutating: `world.preview` runs a
simulation in memory and writes nothing. Mutating commands stay refused with the
existing 503.

## Consequences

- Adding a capability is more work, and the work is the part that makes it
  usable by anyone other than its author.
- The manifest can be wrong in ways the harness cannot catch — a description can
  lie. It cannot be *incomplete* without failing.
- Existing packages were not retrofitted into capabilities. Converting them
  would be a large mechanical change with no test behind it, and the contract is
  proven by two real capabilities rather than by twenty declared ones.
