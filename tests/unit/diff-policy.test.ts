import { describe, expect, it } from 'vitest';
import { analyzeDiff, diffDocuments, outOfScopeChanges, setAtPath } from '@atc/runtime-core';
import { validateProject, validateProjectReferences } from '@atc/schema';
import { loadDemoProject } from '../fixtures/project.ts';

const project = loadDemoProject();

describe('diffing', () => {
  it('reports nothing for an unchanged document', () => {
    expect(diffDocuments(project, project)).toEqual([]);
  });

  it('reports a single modified leaf', () => {
    const edited = setAtPath(project, '/graph/transitions/idle-to-walk/blendDurationSec', 0.3);
    const changes = diffDocuments(project, edited);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe('modified');
    expect(changes[0]!.before).toBe(0.18);
    expect(changes[0]!.after).toBe(0.3);
  });

  it('detects removals', () => {
    const edited = {
      ...project,
      graph: {
        ...project.graph,
        transitions: project.graph.transitions.filter((t) => t.id !== 'idle-to-walk'),
      },
    };
    const removals = diffDocuments(project, edited).filter((c) => c.kind === 'removed');
    expect(removals.length).toBeGreaterThan(0);
  });
});

describe('diff policy', () => {
  it('allows an ordinary edit', () => {
    const edited = setAtPath(project, '/graph/transitions/idle-to-walk/blendDurationSec', 0.2);
    const report = analyzeDiff(project, edited);
    expect(report.commitAllowed).toBe(true);
    expect(report.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
  });

  it('blocks a change to a locked value', () => {
    const edited = setAtPath(project, '/movement/jumpHeight', 3);
    const report = analyzeDiff(project, edited);
    expect(report.commitAllowed).toBe(false);
    expect(report.findings[0]!.rule).toBe('protected-value-changed');
  });

  it('warns, but does not block, on an approval-required change', () => {
    const edited = setAtPath(project, '/graph/transitions/run-to-attack-01/blendDurationSec', 0.09);
    const report = analyzeDiff(project, edited);
    expect(report.commitAllowed).toBe(true);
    expect(report.findings.some((f) => f.rule === 'approval-required-changed')).toBe(true);
  });

  it('blocks deleting a state', () => {
    const edited = {
      ...project,
      graph: { ...project.graph, states: project.graph.states.filter((s) => s.id !== 'slide') },
    };
    const report = analyzeDiff(project, edited);
    expect(report.commitAllowed).toBe(false);
    expect(report.findings.some((f) => f.rule === 'state-removed')).toBe(true);
  });

  it('blocks deleting a transition', () => {
    const edited = {
      ...project,
      graph: {
        ...project.graph,
        transitions: project.graph.transitions.filter((t) => t.id !== 'any-to-dodge'),
      },
    };
    const report = analyzeDiff(project, edited);
    expect(report.findings.some((f) => f.rule === 'transition-removed')).toBe(true);
    expect(report.commitAllowed).toBe(false);
  });

  it('does not report a clip removal when only an optional clip field is removed', () => {
    const edited = structuredClone(project);
    const recovery = edited.clips.find((clip) => clip.id === 'unarmed-attack-01-recovery')!;
    delete recovery.provenance?.humanFinal;

    const report = analyzeDiff(project, edited);
    expect(report.findings.some((finding) => finding.rule === 'clip-removed')).toBe(false);
    expect(report.commitAllowed).toBe(true);
  });

  it('still blocks deleting an entire clip', () => {
    const edited = {
      ...project,
      clips: project.clips.filter((clip) => clip.id !== 'unarmed-attack-01-recovery'),
    };
    const report = analyzeDiff(project, edited);
    expect(report.findings.some((finding) => finding.rule === 'clip-removed')).toBe(true);
    expect(report.commitAllowed).toBe(false);
  });

  it('blocks deleting a haptic binding, which would lose a fallback', () => {
    const edited = {
      ...project,
      haptics: {
        ...project.haptics,
        bindings: project.haptics.bindings.filter((b) => b.id !== 'haptic-landing'),
      },
    };
    const report = analyzeDiff(project, edited);
    expect(report.findings.some((f) => f.rule === 'haptic-fallback-removed')).toBe(true);
    expect(report.commitAllowed).toBe(false);
  });

  it('blocks weakening a protection level', () => {
    const edited = setAtPath(
      project,
      '/graph/transitions/run-to-attack-01/protection/level',
      'editable',
    );
    const report = analyzeDiff(project, edited);
    expect(report.findings.some((f) => f.rule === 'protection-weakened')).toBe(true);
    expect(report.commitAllowed).toBe(false);
  });

  it('permits strengthening a protection level', () => {
    const edited = setAtPath(
      project,
      '/graph/transitions/run-to-attack-01/protection/level',
      'locked',
    );
    expect(analyzeDiff(project, edited).commitAllowed).toBe(true);
  });

  it('identifies changes outside the requested scope', () => {
    let edited = setAtPath(project, '/graph/transitions/idle-to-walk/blendDurationSec', 0.2);
    edited = setAtPath(edited, '/camera/distance', 9);
    const changes = diffDocuments(project, edited);
    const stray = outOfScopeChanges(changes, ['/graph/transitions/idle-to-walk']);
    expect(stray).toHaveLength(1);
    expect(stray[0]!.path).toBe('/camera/distance');
  });
});

describe('canonical project validation', () => {
  it('validates the committed demo project against the schema', () => {
    const result = validateProject(project);
    expect(result.issues).toEqual([]);
  });

  it('has no dangling references or unreachable states', () => {
    const result = validateProjectReferences(project);
    expect(result.issues).toEqual([]);
  });

  it('rejects a transition pointing at a state that does not exist', () => {
    const broken = setAtPath(project, '/graph/transitions/idle-to-walk/to', 'nonexistent');
    const result = validateProjectReferences(broken);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.keyword === 'reference')).toBe(true);
  });

  it('rejects an out-of-range value', () => {
    const broken = setAtPath(project, '/graph/transitions/idle-to-walk/blendDurationSec', 99);
    expect(validateProject(broken).valid).toBe(false);
  });

  it('rejects an unknown extra property', () => {
    const broken = setAtPath(project, '/camera/somethingNew', 1);
    expect(validateProject(broken).valid).toBe(false);
  });
});
