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
  /**
   * The registry the subject resolved against.
   *
   * Kept on the session because publication needs the *stored* asset — the
   * resolved document is a join and cannot be written back — and the session is
   * the one thing that already knows which registry produced it. A second
   * registry reached for independently could disagree, and the disagreement
   * would surface as publishing a draft built from assets the preview never
   * used.
   */
  animationRegistry: AnimationAssetRegistry;
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
    animationRegistry: input.animationRegistry,
    baseRevisionId: input.baseRevisionId,
    previewOverrides: input.previewOverrides ?? [],
    stagedChanges: null,
    state: 'resolved',
    dispose: () => engine.dispose(),
  };
}
