import type { ProtectionLevel, ProtectionMetadata } from '@atc/schema';
import { ancestorPaths, getAtPath, splitPath, type CanonicalPath } from './paths.ts';

/** Who is attempting the change. Human intent and AI intent are not the same. */
export type EditActor = 'human' | 'ai';

export interface EditRequest {
  path: CanonicalPath;
  actor: EditActor;
  /** True when a human has explicitly approved this specific change. */
  approved?: boolean;
  /** True when a human has explicitly unlocked this path for this session. */
  unlocked?: boolean;
}

export interface EditDecision {
  allowed: boolean;
  /** Set when the change is possible but needs a human to sign off first. */
  requiresApproval: boolean;
  level: ProtectionLevel;
  reason: string;
  /** Path that carried the governing protection metadata. */
  governedBy: CanonicalPath | null;
}

const LEVEL_RANK: Record<ProtectionLevel, number> = {
  editable: 0,
  'approval-required': 1,
  locked: 2,
  invariant: 3,
};

export function isStricter(a: ProtectionLevel, b: ProtectionLevel): boolean {
  return LEVEL_RANK[a] > LEVEL_RANK[b];
}

export function strictest(levels: ProtectionLevel[]): ProtectionLevel {
  return levels.reduce<ProtectionLevel>(
    (worst, level) => (isStricter(level, worst) ? level : worst),
    'editable',
  );
}

interface ResolvedProtection {
  level: ProtectionLevel;
  reason: string;
  governedBy: CanonicalPath | null;
}

/**
 * Resolves the protection governing `path`. Protection is inherited: metadata
 * on an object applies to every field beneath it, and `protection.fields` may
 * raise the level for one specific field. The strictest applicable level wins,
 * so nothing can be weakened by adding a nested annotation.
 */
export function resolveProtection(root: unknown, path: CanonicalPath): ResolvedProtection {
  let level: ProtectionLevel = 'editable';
  let reason = '';
  let governedBy: CanonicalPath | null = null;

  // Walk from the root down so deeper (more specific) metadata is considered last,
  // but only adopt a level when it is stricter than what we already have.
  const chain = ancestorPaths(path).reverse();
  const consider = (candidate: ProtectionLevel, why: string, source: CanonicalPath) => {
    if (isStricter(candidate, level)) {
      level = candidate;
      reason = why;
      governedBy = source;
    }
  };

  const rootProtection = (root as { protection?: ProtectionMetadata }).protection;
  if (rootProtection) {
    consider(rootProtection.level, rootProtection.reason ?? 'project protection', '/');
  }

  for (const ancestor of chain) {
    const node = getAtPath(root, ancestor);
    if (node === undefined || node === null || typeof node !== 'object') continue;
    const protection = (node as { protection?: ProtectionMetadata }).protection;
    if (!protection) continue;

    consider(protection.level, protection.reason ?? 'protected value', ancestor);

    // Field-level overrides only apply to the immediate child named in `fields`.
    if (protection.fields) {
      const remaining = splitPath(path).slice(splitPath(ancestor).length);
      const fieldName = remaining[0];
      if (fieldName !== undefined) {
        const fieldLevel = protection.fields[fieldName];
        if (fieldLevel) {
          consider(fieldLevel, `field "${fieldName}" is ${fieldLevel}`, `${ancestor}/${fieldName}`);
        }
      }
    }
  }

  return { level, reason, governedBy };
}

/**
 * The single gate every write goes through — UI edits, AI patches and API
 * commits all call this. Nothing may bypass it.
 */
export function evaluateEdit(root: unknown, request: EditRequest): EditDecision {
  const { level, reason, governedBy } = resolveProtection(root, request.path);

  const base = { level, governedBy };

  switch (level) {
    case 'editable':
      return { ...base, allowed: true, requiresApproval: false, reason: '' };

    case 'approval-required':
      if (request.actor === 'human') {
        // A human editing an approval-required value is itself the approval.
        return { ...base, allowed: true, requiresApproval: false, reason: '' };
      }
      if (request.approved) {
        return { ...base, allowed: true, requiresApproval: false, reason: '' };
      }
      return {
        ...base,
        allowed: false,
        requiresApproval: true,
        reason: reason || 'requires human approval before an AI change is applied',
      };

    case 'locked':
      if (request.unlocked && request.actor === 'human') {
        return { ...base, allowed: true, requiresApproval: false, reason: '' };
      }
      return {
        ...base,
        allowed: false,
        requiresApproval: false,
        reason: reason || 'value is locked; a human must unlock it first',
      };

    case 'invariant':
      return {
        ...base,
        allowed: false,
        requiresApproval: false,
        reason: reason || 'value is a project invariant and cannot be changed by tooling',
      };
  }
}

/** Convenience predicate for UI affordances (disabled sliders, lock badges). */
export function canAiEdit(root: unknown, path: CanonicalPath): boolean {
  return evaluateEdit(root, { path, actor: 'ai' }).allowed;
}

/**
 * Whether an AI may *propose* a change to this path — a strictly weaker
 * question than whether it may apply one.
 *
 * `approval-required` exists precisely so an AI can suggest a value that a human
 * then accepts or rejects, so proposals are allowed there and the proposal is
 * flagged as needing approval. `locked` and `invariant` are refused outright:
 * those must not even appear as a suggestion, because a suggestion is how a
 * confirmed value gets talked back into changing.
 */
export function canAiPropose(root: unknown, path: CanonicalPath): boolean {
  const { level } = resolveProtection(root, path);
  return level === 'editable' || level === 'approval-required';
}

/** True when applying a change here needs explicit human sign-off. */
export function requiresHumanApproval(root: unknown, path: CanonicalPath): boolean {
  return resolveProtection(root, path).level === 'approval-required';
}

export function canHumanEdit(root: unknown, path: CanonicalPath): boolean {
  return evaluateEdit(root, { path, actor: 'human' }).allowed;
}
