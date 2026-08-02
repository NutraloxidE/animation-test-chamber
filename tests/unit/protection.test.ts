import { describe, expect, it } from 'vitest';
import {
  canAiEdit,
  canAiPropose,
  evaluateEdit,
  getAtPath,
  requiresHumanApproval,
  resolveProtection,
  setAtPath,
  strictest,
} from '@atc/runtime-core';
import { loadResolvedDemoProject } from '../fixtures/project.ts';

const project = loadResolvedDemoProject();

const APPROVAL_PATH = '/graph/transitions/run-to-attack-01/blendDurationSec';
const LOCKED_FIELD_PATH = '/graph/transitions/run-to-attack-01/momentumRetention';
const LOCKED_MOVEMENT_PATH = '/movement/jumpHeight';
const EDITABLE_PATH = '/graph/transitions/idle-to-walk/blendDurationSec';

describe('protection resolution', () => {
  it('treats an unannotated value as editable', () => {
    expect(resolveProtection(project, EDITABLE_PATH).level).toBe('editable');
    expect(canAiEdit(project, EDITABLE_PATH)).toBe(true);
  });

  it('inherits object-level protection down to its fields', () => {
    expect(resolveProtection(project, APPROVAL_PATH).level).toBe('approval-required');
  });

  it('lets a field override raise the level but never lower it', () => {
    // The transition is approval-required; this field is declared locked.
    expect(resolveProtection(project, LOCKED_FIELD_PATH).level).toBe('locked');
  });

  it('applies a field override on an otherwise editable object', () => {
    expect(resolveProtection(project, LOCKED_MOVEMENT_PATH).level).toBe('locked');
    expect(resolveProtection(project, '/movement/walkSpeed').level).toBe('editable');
  });

  it('picks the strictest level from a set', () => {
    expect(strictest(['editable', 'approval-required', 'locked'])).toBe('locked');
    expect(strictest(['editable', 'editable'])).toBe('editable');
    expect(strictest(['locked', 'invariant'])).toBe('invariant');
  });
});

describe('edit gate', () => {
  it('allows a human to change an approval-required value directly', () => {
    const decision = evaluateEdit(project, { path: APPROVAL_PATH, actor: 'human' });
    expect(decision.allowed).toBe(true);
  });

  it('refuses an unapproved AI change to an approval-required value', () => {
    const decision = evaluateEdit(project, { path: APPROVAL_PATH, actor: 'ai' });
    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });

  it('allows an approved AI change to an approval-required value', () => {
    const decision = evaluateEdit(project, { path: APPROVAL_PATH, actor: 'ai', approved: true });
    expect(decision.allowed).toBe(true);
  });

  it('refuses a locked value to both actors until a human unlocks it', () => {
    expect(evaluateEdit(project, { path: LOCKED_FIELD_PATH, actor: 'ai' }).allowed).toBe(false);
    expect(evaluateEdit(project, { path: LOCKED_FIELD_PATH, actor: 'human' }).allowed).toBe(false);
    expect(
      evaluateEdit(project, { path: LOCKED_FIELD_PATH, actor: 'human', unlocked: true }).allowed,
    ).toBe(true);
  });

  it('never lets an AI unlock a locked value, even claiming approval', () => {
    const decision = evaluateEdit(project, {
      path: LOCKED_FIELD_PATH,
      actor: 'ai',
      approved: true,
      unlocked: true,
    });
    expect(decision.allowed).toBe(false);
  });

  it('refuses an invariant to everyone', () => {
    const withInvariant = setAtPath(project, '/camera/protection', {
      level: 'invariant',
      reason: 'test',
    });
    const decision = evaluateEdit(withInvariant, {
      path: '/camera/distance',
      actor: 'human',
      unlocked: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.level).toBe('invariant');
  });
});

describe('propose versus apply', () => {
  it('lets an AI propose an approval-required value it may not apply', () => {
    expect(canAiPropose(project, APPROVAL_PATH)).toBe(true);
    expect(canAiEdit(project, APPROVAL_PATH)).toBe(false);
    expect(requiresHumanApproval(project, APPROVAL_PATH)).toBe(true);
  });

  it('refuses to even propose a locked value', () => {
    expect(canAiPropose(project, LOCKED_FIELD_PATH)).toBe(false);
  });
});

describe('canonical paths', () => {
  it('addresses array items by id, not index', () => {
    const value = getAtPath(project, '/graph/transitions/run-to-attack-01/blendDurationSec');
    expect(value).toBe(0.11);
  });

  it('does not mutate the source document when setting a value', () => {
    const before = getAtPath(project, EDITABLE_PATH);
    const next = setAtPath(project, EDITABLE_PATH, 0.5);
    expect(getAtPath(next, EDITABLE_PATH)).toBe(0.5);
    expect(getAtPath(project, EDITABLE_PATH)).toBe(before);
  });

  it('addresses input bindings by their action, which is their identity', () => {
    // Input bindings carry no `id`; the action they map to *is* the identity,
    // and project invariants reference them that way.
    expect(getAtPath(project, '/inputMap/keyboard/Jump/codes')).toEqual(['Space']);
    expect(getAtPath(project, '/inputMap/gamepad/Dodge/buttons')).toEqual([1, 5]);
  });

  it('resolves every declared project invariant', () => {
    for (const invariant of project.invariants) {
      expect(getAtPath(project, invariant.path), `${invariant.path} is a dead reference`).toBeDefined();
    }
  });

  it('keeps a path stable when items are reordered', () => {
    const reordered = {
      ...project,
      graph: { ...project.graph, transitions: [...project.graph.transitions].reverse() },
    };
    expect(getAtPath(reordered, '/graph/transitions/run-to-attack-01/blendDurationSec')).toBe(0.11);
  });
});
