import { describe, expect, it } from 'vitest';
import {
  animationSubjectId,
  animationSubjectSemanticIssues,
  validateAgainst,
} from '@atc/schema';
import { animationSubjectFromPrefab } from '@atc/prefab-runtime';
import {
  animatorComponent,
  basePrefab,
  modelComponent,
  node,
  referenceTo,
  registryOf,
} from '../prefabs/fixtures.ts';

function fixture() {
  const prefab = basePrefab(
    'animated-prop',
    node('root', [modelComponent('navigator')], [
      { kind: 'inline', node: node('animated-child', [animatorComponent()]) },
    ]),
  );
  const reference = referenceTo(prefab);
  return { prefab, reference, registry: registryOf(prefab) };
}

describe('AnimationSubjectDefinition', () => {
  it('is closed and requires exact Prefab identity', () => {
    const { reference, registry } = fixture();
    const extracted = animationSubjectFromPrefab({
      registry,
      reference,
      nodeId: 'animated-child',
      componentId: 'animator',
    });
    expect(extracted.subject).toBeDefined();
    expect(validateAgainst('AnimationSubjectDefinition', extracted.subject).valid).toBe(true);
    expect(validateAgainst('AnimationSubjectDefinition', { ...extracted.subject, surprise: true }).valid).toBe(false);
    expect(validateAgainst('AnimationSubjectDefinition', {
      ...extracted.subject,
      source: { ...extracted.subject!.source, prefab: { ...reference, contentHash: '' } },
    }).valid).toBe(false);
  });

  it('checks component identity semantically', () => {
    const { reference, registry } = fixture();
    const subject = animationSubjectFromPrefab({ registry, reference, nodeId: 'animated-child', componentId: 'animator' }).subject!;
    expect(animationSubjectSemanticIssues(subject)).toEqual([]);
    expect(animationSubjectSemanticIssues({ ...subject, source: { ...subject.source, componentId: 'other' } })).toContain('source.componentId must match animator.componentId');
    expect(subject.subjectId).toBe(animationSubjectId(subject.source));
  });
});

describe('animationSubjectFromPrefab', () => {
  it('extracts the exact inline Animator and preserves missing-presentation editing', () => {
    const { reference, registry } = fixture();
    const result = animationSubjectFromPrefab({ registry, reference, nodeId: 'animated-child', componentId: 'animator' });
    expect(result.subject?.source).toEqual({ prefab: reference, nodeId: 'animated-child', componentId: 'animator' });
    expect(result.subject?.presentation.model).toBeUndefined();
    expect(result.issues.map((issue) => issue.code)).toContain('missing-presentation');
  });

  it('never falls back to the first node or Component', () => {
    const { reference, registry } = fixture();
    expect(animationSubjectFromPrefab({ registry, reference, nodeId: 'missing', componentId: 'animator' }).issues[0]?.code).toBe('unknown-node');
    expect(animationSubjectFromPrefab({ registry, reference, nodeId: 'root', componentId: 'missing' }).issues[0]?.code).toBe('unknown-component');
    expect(animationSubjectFromPrefab({ registry, reference, nodeId: 'root', componentId: 'model' }).issues[0]?.code).toBe('non-animator-component');
  });
});
