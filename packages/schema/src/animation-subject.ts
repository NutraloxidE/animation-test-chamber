import { Type, type Static } from '@sinclair/typebox';
import { Id, SchemaVersion, Vec3 } from './common.ts';
import {
  AnimatorComponent,
  EquipmentSocketsComponent,
  GameObjectPrefabReference,
  RenderableModelBinding,
} from './prefab.ts';

export const AnimationSubjectDefinition = Type.Object(
  {
    schemaVersion: SchemaVersion,
    subjectId: Type.String({ minLength: 1, maxLength: 512 }),
    displayName: Type.String({ minLength: 1, maxLength: 256 }),
    source: Type.Object(
      {
        prefab: GameObjectPrefabReference,
        nodeId: Id,
        componentId: Id,
      },
      { additionalProperties: false },
    ),
    animator: AnimatorComponent,
    presentation: Type.Object(
      {
        model: Type.Optional(RenderableModelBinding),
        capsule: Type.Optional(
          Type.Object(
            { radius: Type.Number(), height: Type.Number(), center: Vec3 },
            { additionalProperties: false },
          ),
        ),
        equipmentSockets: Type.Optional(EquipmentSocketsComponent),
      },
      { additionalProperties: false },
    ),
  },
  { $id: 'AnimationSubjectDefinition', additionalProperties: false },
);
export type AnimationSubjectDefinition = Static<typeof AnimationSubjectDefinition>;

export function animationSubjectId(input: {
  prefab: GameObjectPrefabReference;
  nodeId: string;
  componentId: string;
}): string {
  return `game-object-prefab:${input.prefab.assetId}@${input.prefab.version}/${input.nodeId}/${input.componentId}`;
}

export function animationSubjectSemanticIssues(subject: AnimationSubjectDefinition): string[] {
  const issues: string[] = [];
  if (subject.source.componentId !== subject.animator.componentId) {
    issues.push('source.componentId must match animator.componentId');
  }
  if (subject.animator.componentType !== 'animator') {
    issues.push('animator must be an Animator Component');
  }
  const expected = animationSubjectId(subject.source);
  if (subject.subjectId !== expected) issues.push(`subjectId must be ${expected}`);
  return issues;
}
