import { useAnimationChamber } from './useAnimationChamber.ts';
import { useAnimationPublication } from './useAnimationPublication.ts';

export function SubjectConflictBanner(): JSX.Element | null {
  const subject = useAnimationChamber((state) => state.subject);
  const session = useAnimationChamber((state) => state.session);
  const setStatus = useAnimationChamber((state) => state.setStatus);
  const revert = useAnimationChamber((state) => state.revertSession);
  const publication = useAnimationPublication();
  if (publication.stage !== 'refused') return null;
  return (
    <section className="subject-conflict-banner" data-testid="subject-conflict-banner">
      <strong>Subject draft conflict</strong>
      <p><code>{subject.subjectId}</code> at {subject.source.prefab.contentHash}; {session.stagedPaths.length} staged path(s). The repository or approved publication snapshot changed, so this draft was not auto-applied.</p>
      <div className="button-row">
        <button type="button" onClick={revert}>Discard draft</button>
        <button type="button" onClick={() => setStatus('Patch export requested. The local staged draft remains unchanged.')}>Export patch</button>
        <button type="button" onClick={() => window.location.reload()}>Reload latest</button>
      </div>
    </section>
  );
}
