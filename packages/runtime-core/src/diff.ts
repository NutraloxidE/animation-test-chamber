import { flattenValues, getAtPath, type CanonicalPath } from './paths.ts';
import { resolveProtection } from './protection.ts';
import type { ProtectionLevel } from '@atc/schema';

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface FieldChange {
  path: CanonicalPath;
  kind: ChangeKind;
  before: unknown;
  after: unknown;
  /** Protection governing this path in the *before* document. */
  protection: ProtectionLevel;
}

/**
 * Severity classes from PLAN 9.4. Anything above `informational` is surfaced
 * loudly in the diff panel and blocks a commit unless explicitly acknowledged.
 */
export type DiffSeverity = 'informational' | 'warning' | 'blocking';

export interface DiffFinding {
  path: CanonicalPath;
  severity: DiffSeverity;
  rule: string;
  message: string;
}

export interface DiffReport {
  changes: FieldChange[];
  findings: DiffFinding[];
  /** True when nothing blocking was found. */
  commitAllowed: boolean;
}

export function diffDocuments(before: unknown, after: unknown): FieldChange[] {
  const beforeMap = flattenValues(before);
  const afterMap = flattenValues(after);
  const changes: FieldChange[] = [];

  for (const [path, beforeValue] of beforeMap) {
    if (!afterMap.has(path)) {
      changes.push({
        path,
        kind: 'removed',
        before: beforeValue,
        after: undefined,
        protection: resolveProtection(before, path).level,
      });
      continue;
    }
    const afterValue = afterMap.get(path);
    if (!Object.is(beforeValue, afterValue)) {
      changes.push({
        path,
        kind: 'modified',
        before: beforeValue,
        after: afterValue,
        protection: resolveProtection(before, path).level,
      });
    }
  }

  for (const [path, afterValue] of afterMap) {
    if (!beforeMap.has(path)) {
      changes.push({
        path,
        kind: 'added',
        before: undefined,
        after: afterValue,
        protection: resolveProtection(before, path).level,
      });
    }
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

/**
 * Removal rules match the *entity* a removed leaf belongs to.
 *
 * The diff walks leaves, so deleting one transition shows up as a dozen removed
 * fields. Each rule captures the owning entity path in group 1 so the findings
 * can be collapsed back to "one transition was removed" instead of burying the
 * reader in field-level noise.
 */
const REMOVAL_RULES: { test: RegExp; rule: string; message: string }[] = [
  {
    test: /^(\/graph\/states\/[^/]+)(\/|$)/,
    rule: 'state-removed',
    message: 'a state was removed from the animation graph',
  },
  {
    test: /^(\/graph\/transitions\/[^/]+)(\/|$)/,
    rule: 'transition-removed',
    message: 'a transition was removed from the animation graph',
  },
  {
    test: /^(\/inputMap\/(?:keyboard|gamepad)\/[^/]+)(\/|$)/,
    rule: 'input-action-removed',
    message: 'an input binding was removed',
  },
  {
    test: /^(\/haptics\/bindings\/[^/]+)(\/|$)/,
    rule: 'haptic-fallback-removed',
    message: 'a haptic binding was removed; capability fallback may be lost',
  },
  {
    test: /^(\/clips\/[^/]+)(\/|$)/,
    rule: 'clip-removed',
    message: 'an animation clip was removed',
  },
  {
    test: /^(\/invariants\/[^/]+)(\/|$)/,
    rule: 'invariant-removed',
    message: 'a project invariant was removed',
  },
];

/**
 * Classifies raw changes against the diff policy. This is what stops an AI from
 * quietly deleting a fallback or relaxing a protection level while doing
 * something unrelated.
 */
export function analyzeDiff(before: unknown, after: unknown): DiffReport {
  const changes = diffDocuments(before, after);
  const findings: DiffFinding[] = [];
  // Collapses the many removed leaves of one deleted entity into one finding.
  const reportedRemovals = new Set<string>();

  for (const change of changes) {
    if (change.protection === 'locked' || change.protection === 'invariant') {
      findings.push({
        path: change.path,
        severity: 'blocking',
        rule: 'protected-value-changed',
        message: `${change.protection} value changed without an explicit unlock`,
      });
      continue;
    }

    if (change.kind === 'removed') {
      let matchedRule = false;
      for (const rule of REMOVAL_RULES) {
        const match = rule.test.exec(change.path);
        if (!match) continue;
        const entityPath = match[1]!;
        // Removing an optional leaf (for example provenance.humanFinal) is not
        // the same as deleting its owning clip, state, transition or binding.
        if (getAtPath(after, entityPath) !== undefined) continue;
        matchedRule = true;
        const key = `${rule.rule}:${entityPath}`;
        if (!reportedRemovals.has(key)) {
          reportedRemovals.add(key);
          findings.push({
            path: entityPath,
            severity: 'blocking',
            rule: rule.rule,
            message: rule.message,
          });
        }
        break;
      }
      if (matchedRule) continue;
    }

    // Weakening a protection level is always suspicious, even human-initiated.
    if (change.path.endsWith('/protection/level')) {
      const rank: Record<string, number> = {
        editable: 0,
        'approval-required': 1,
        locked: 2,
        invariant: 3,
      };
      const beforeRank = rank[String(change.before)] ?? 0;
      const afterRank = rank[String(change.after)] ?? 0;
      if (afterRank < beforeRank) {
        findings.push({
          path: change.path,
          severity: 'blocking',
          rule: 'protection-weakened',
          message: `protection weakened from ${String(change.before)} to ${String(change.after)}`,
        });
        continue;
      }
    }

    if (change.protection === 'approval-required') {
      findings.push({
        path: change.path,
        severity: 'warning',
        rule: 'approval-required-changed',
        message: 'human-tuned value changed; confirm this was intended',
      });
    }
  }

  return {
    changes,
    findings,
    commitAllowed: !findings.some((finding) => finding.severity === 'blocking'),
  };
}

/** Changes scoped to a set of paths the human actually asked to touch. */
export function outOfScopeChanges(
  changes: FieldChange[],
  requestedPaths: CanonicalPath[],
): FieldChange[] {
  return changes.filter(
    (change) => !requestedPaths.some((requested) => change.path.startsWith(requested)),
  );
}
