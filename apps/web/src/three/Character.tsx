import type { ChamberEngine } from '../engine.ts';
import type { CharacterPreset, WeaponGrip, WeaponMode } from './catalog.ts';
import { GltfCharacter } from './characters/GltfCharacter.tsx';
import { ProceduralCharacter } from './characters/ProceduralCharacter.tsx';

interface CharacterProps {
  engine: ChamberEngine;
  ghost?: boolean;
  color?: string;
  character?: CharacterPreset;
  weapon: WeaponMode;
  grip?: WeaponGrip;
  gripEditorMode?: 'translate' | 'rotate' | null;
  onGripChange?(grip: WeaponGrip): void;
}

export function Character(props: CharacterProps) {
  if (!props.ghost && props.character?.modelUrl) {
    return (
      <GltfCharacter
        engine={props.engine}
        character={props.character}
        weapon={props.weapon}
        grip={props.grip}
        gripEditorMode={props.gripEditorMode}
        onGripChange={props.onGripChange}
      />
    );
  }
  return <ProceduralCharacter {...props} />;
}
