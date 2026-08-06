import type { AnimationSubjectDefinition, CanonicalPatch } from '@atc/schema';
import type {
  AnimationAssetRegistry,
  ResolvedAnimationSubject,
} from '@atc/animation-asset-runtime';
import { resolveAnimationSubject } from '@atc/animation-asset-runtime';

export type AnimationAuthoringSessionState = 'loading' | 'resolved' | 'unavailable' | 'conflict';

export interface DisposableAnimationPreview {
  dispose(): void;
}

export interface AnimationAuthoringSession<TEngine extends DisposableAnimationPreview = DisposableAnimationPreview> {
  subject: AnimationSubjectDefinition;
  resolved: ResolvedAnimationSubject;
  engine: TEngine;
  baseRevisionId: string;
  previewOverrides: readonly CanonicalPatch[];
  stagedChanges: unknown;
  state: AnimationAuthoringSessionState;
  dispose(): void;
}

export function createAnimationAuthoringSession<TEngine extends DisposableAnimationPreview>(input: {
  subject: AnimationSubjectDefinition;
  animationRegistry: AnimationAssetRegistry;
  baseRevisionId: string;
  previewOverrides?: readonly CanonicalPatch[];
  createEngine(resolved: ResolvedAnimationSubject): TEngine;
}): AnimationAuthoringSession<TEngine> {
  const result = resolveAnimationSubject({
    subject: input.subject,
    animationRegistry: input.animationRegistry,
    previewOverrides: input.previewOverrides,
  });
  if (result.issues.some((issue) => issue.severity === 'error')) {
    throw new Error(result.issues.map((issue) => issue.message).join('; '));
  }
  const engine = input.createEngine(result.resolved);
  return {
    subject: input.subject,
    resolved: result.resolved,
    engine,
    baseRevisionId: input.baseRevisionId,
    previewOverrides: input.previewOverrides ?? [],
    stagedChanges: null,
    state: 'resolved',
    dispose: () => engine.dispose(),
  };
}
