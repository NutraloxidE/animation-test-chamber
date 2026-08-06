import { useEffect } from 'react';
import type { AnimationSubjectDefinition } from '@atc/schema';
import { App } from '../App.tsx';
import { useChamber } from '../store.ts';
import { legacyCharacterIdForAnimationSubject } from './legacy-animation-workspace-adapter.ts';

export function AnimationWorkspace({ subject }: { subject: AnimationSubjectDefinition }): JSX.Element {
  const activeCharacterId = useChamber((state) => state.activeCharacterId);
  const setActiveCharacter = useChamber((state) => state.setActiveCharacter);
  const legacyCharacterId = useChamber((state) =>
    legacyCharacterIdForAnimationSubject(subject, state.canonicalProject),
  );

  useEffect(() => {
    if (legacyCharacterId && legacyCharacterId !== activeCharacterId) setActiveCharacter(legacyCharacterId);
  }, [activeCharacterId, legacyCharacterId, setActiveCharacter]);

  if (!legacyCharacterId) {
    return (
      <section className="empty-state" data-testid="animation-subject-unavailable">
        <h2>Animation subject unavailable</h2>
        <p>
          The exact Animator <code>{subject.subjectId}</code> has no unique temporary legacy UI
          projection. Its graph remains addressable through the subject resolver.
        </p>
      </section>
    );
  }
  if (activeCharacterId !== legacyCharacterId) {
    return <p data-testid="animation-subject-loading">Loading exact animation subjectâ€¦</p>;
  }
  return <App />;
}
