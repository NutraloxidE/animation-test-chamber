import type { CharacterModelBinding } from '@atc/schema';
import type { ChamberEngine } from '../engine.ts';
import type { ResolvedCharacterPresentation } from '../rig-editor/resolve-character-presentation.ts';
import type { WeaponGrip, WeaponMode } from './catalog.ts';
import { GltfCharacter } from './characters/GltfCharacter.tsx';
import { ProceduralCharacter } from './characters/ProceduralCharacter.tsx';

interface CharacterProps {
  engine: ChamberEngine;
  ghost?: boolean;
  color?: string;
  /** The route Character's resolved presentation. Absent only for a ghost. */
  presentation?: ResolvedCharacterPresentation;
  weapon: WeaponMode;
  grip?: WeaponGrip;
  gripEditorMode?: 'translate' | 'rotate' | null;
  onGripChange?(grip: WeaponGrip): void;
}

/**
 * Which renderer draws the route Character.
 *
 * The branch is on the *authored* model binding's kind, resolved upstream — not
 * on "does this preset happen to carry a `modelUrl`". Two Characters can no
 * longer disagree about which of them the Viewport is showing, because there is
 * only one presentation and the route produced it.
 */
export function Character(props: CharacterProps) {
  const model: CharacterModelBinding | undefined = props.presentation?.model.effective;
  if (!props.ghost && props.presentation && model?.kind === 'repository-model') {
    return (
      <GltfCharacter
        engine={props.engine}
        model={model}
        presentation={props.presentation}
        weapon={props.weapon}
        grip={props.grip}
        gripEditorMode={props.gripEditorMode}
        onGripChange={props.onGripChange}
      />
    );
  }
  return (
    <ProceduralCharacter
      engine={props.engine}
      ghost={props.ghost}
      color={props.color}
      presetId={model?.kind === 'procedural-humanoid' ? model.presetId : undefined}
      weapon={props.weapon}
    />
  );
}
