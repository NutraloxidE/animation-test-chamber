/**
 * Which Character Definition is being authored — said once, at the top.
 *
 * The picker lists canonical Characters from the project, not catalogue preset
 * entries. Switching is guarded: the edit session is shared, so carrying staged
 * changes into a different character is how one character's tuning is saved
 * onto another, and dropping them silently loses work the user still thinks
 * they have. Neither happens without being asked.
 */
import { useState } from 'react';
import { useChamber } from '../store.ts';

export function CharacterLabHeader() {
  const characters = useChamber((state) => state.canonicalProject.characters);
  const editingCharacterId = useChamber((state) => state.editingCharacterId);
  const setEditingCharacter = useChamber((state) => state.setEditingCharacter);
  const stagedCharacterEdits = useChamber((state) => state.stagedCharacterEdits);
  const workspaceReturn = useChamber((state) => state.workspaceReturn);
  const clearWorkspaceReturn = useChamber((state) => state.clearWorkspaceReturn);
  const setPrimaryWorkspace = useChamber((state) => state.setPrimaryWorkspace);
  const setBottomWorkspace = useChamber((state) => state.setBottomWorkspace);
  const revertSession = useChamber((state) => state.revertSession);

  /** A pending switch, held until the user says what to do with staged work. */
  const [pending, setPending] = useState<{ characterId: string; staged: string[] } | null>(
    null,
  );

  const requestSwitch = (characterId: string): void => {
    if (characterId === editingCharacterId) return;
    const staged = stagedCharacterEdits();
    if (staged.length === 0) {
      setEditingCharacter(characterId);
      return;
    }
    setPending({ characterId, staged });
  };

  return (
    <header className="character-lab__header" data-testid="character-lab-header">
      <h2>Character Lab</h2>
      <span className="workspace__badge">SHARED CHARACTER DEFINITION</span>

      <label className="character-lab__picker">
        Editing Character
        <select
          value={editingCharacterId}
          data-testid="character-lab-select"
          onChange={(event) => requestSwitch(event.target.value)}
        >
          {/* Canonical Character Definitions. Not render presets — those are
              not project data and never belonged in a control shaped like
              this one. */}
          {characters.map((character) => (
            <option key={character.id} value={character.id}>
              {character.displayName} · {character.id}
            </option>
          ))}
        </select>
      </label>

      {workspaceReturn && (
        <button
          type="button"
          className="character-lab__return"
          data-testid="character-lab-return"
          onClick={() => {
            setPrimaryWorkspace(workspaceReturn.workspace);
            clearWorkspaceReturn();
          }}
        >
          ← Back to {workspaceReturn.label}
        </button>
      )}

      {pending && (
        <div
          className="character-lab__guard"
          role="alertdialog"
          aria-label="Unsaved changes"
          data-testid="character-lab-switch-guard"
        >
          <p>
            {pending.staged.length} unsaved{' '}
            {pending.staged.length === 1 ? 'change' : 'changes'} would be abandoned by switching
            to <b>{pending.characterId}</b>.
          </p>
          <ul className="character-lab__guard-paths">
            {/* The paths, not just a count. "You have unsaved work" is not
                actionable; "you edited /clips/dodge/timeCurve" is. */}
            {pending.staged.slice(0, 6).map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
            {pending.staged.length > 6 && <li>…and {pending.staged.length - 6} more</li>}
          </ul>
          <div className="character-lab__guard-actions">
            <button
              type="button"
              data-testid="character-lab-guard-keep"
              onClick={() => setPending(null)}
            >
              Keep editing {editingCharacterId}
            </button>
            <button
              type="button"
              data-testid="character-lab-guard-diff"
              onClick={() => {
                setPending(null);
                setBottomWorkspace('diff');
              }}
            >
              Review Diff
            </button>
            <button
              type="button"
              data-testid="character-lab-guard-discard"
              onClick={() => {
                revertSession();
                setEditingCharacter(pending.characterId);
                setPending(null);
              }}
            >
              Discard and switch
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
