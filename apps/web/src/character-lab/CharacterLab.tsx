/**
 * Character Lab — one shared Character Definition, made production-ready.
 *
 * This is a production stage, not a camera mode. The single-character rig and
 * model preview lives here now: it used to be `View: Rig`, a third stop on the
 * World presentation cycle, which meant the World view could show a skinned
 * character *or* the animation preview but never both, and which made an
 * authoring surface look like a way of pointing the camera.
 *
 * The preview stage is deliberately not a World. It renders the Character being
 * edited, at a neutral stage, with no Instance and no placement — you do not
 * have to put a character into a world to look at it.
 */
import { Viewport } from '../three/Viewport.tsx';
import { useChamber } from '../store.ts';
import { CharacterLabHeader } from './CharacterLabHeader.tsx';
import { CharacterLabInspector } from './CharacterLabInspector.tsx';
import { AnimationWorkspace } from '../workspaces/AnimationWorkspace.tsx';
import { CharacterLabStageControls } from './CharacterLabStageControls.tsx';

export function CharacterLab() {
  const editingCharacterId = useChamber((state) => state.editingCharacterId);
  const characters = useChamber((state) => state.canonicalProject.characters);
  const character =
    characters.find((entry) => entry.id === editingCharacterId) ?? characters[0];

  if (!character) {
    return (
      <div className="character-lab" data-testid="character-lab">
        <p className="workspace__hint">This project declares no Character Definitions.</p>
      </div>
    );
  }

  return (
    <div className="character-lab" data-testid="character-lab">
      <CharacterLabHeader />
      <div className="character-lab__body">
        <div className="character-lab__stage" data-testid="character-lab-stage">
          {/* The legacy focused renderer, in the stage it always belonged to.
              It draws the edit session's resolved character, which is the one
              the header names. */}
          <Viewport />
          <span className="character-lab__stage-badge">Preview Stage</span>
          <CharacterLabStageControls />
        </div>
        <aside className="character-lab__side">
          <CharacterLabInspector character={character} />
        </aside>
      </div>
      {/* One animation workspace, shared with World. Character Lab does not get
          its own Clip Preview — two implementations of "play this clip" is how
          they drift apart. */}
      <div className="character-lab__animation">
        <AnimationWorkspace />
      </div>
    </div>
  );
}
