import type { ChamberEngine } from '../engine.ts';
import type { CharacterPreset, MotionSet } from './catalog.ts';
import { GltfCharacter } from './characters/GltfCharacter.tsx';
import { ProceduralCharacter } from './characters/ProceduralCharacter.tsx';

interface CharacterProps {
  engine: ChamberEngine;
  ghost?: boolean;
  color?: string;
  character?: CharacterPreset;
  motion: MotionSet;
}

export function Character(props: CharacterProps) {
  if (!props.ghost && props.character?.modelUrl) {
    return (
      <GltfCharacter
        engine={props.engine}
        character={props.character}
        motion={props.motion}
      />
    );
  }
  return <ProceduralCharacter {...props} />;
}
