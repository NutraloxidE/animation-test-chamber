import type {
  AnimationSubjectDefinition,
  AnimatorComponent,
  GameObjectPrefabReference,
} from '@atc/schema';
import { animationSubjectId } from '@atc/schema';
import type { AnimationAssetRegistry } from '@atc/animation-asset-runtime';
import type { PrefabAssetRegistry } from './registry.ts';
import { resolveGameObjectPrefab, walkResolvedNodes } from './resolution.ts';

export type AnimationSubjectIssueCode =
  | 'unknown-prefab'
  | 'hash-mismatch'
  | 'unresolvable-prefab'
  | 'unknown-node'
  | 'ambiguous-node'
  | 'unknown-component'
  | 'non-animator-component'
  | 'invalid-assignment'
  | 'missing-animation-asset'
  | 'missing-presentation';

export interface AnimationSubjectIssue {
  code: AnimationSubjectIssueCode;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
}

export function animationSubjectFromPrefab(input: {
  registry: PrefabAssetRegistry;
  animationRegistry?: AnimationAssetRegistry;
  reference: GameObjectPrefabReference;
  nodeId: string;
  componentId: string;
}): { subject?: AnimationSubjectDefinition; issues: AnimationSubjectIssue[] } {
  const { registry, reference } = input;
  if (!registry.has(reference)) {
    return { issues: [{ code: 'unknown-prefab', severity: 'error', message: `unknown Prefab ${reference.assetId}@${reference.version}` }] };
  }
  const referenceIssues = registry.checkReference(reference);
  if (referenceIssues.length > 0) {
    return {
      issues: referenceIssues.map((issue) => ({
        code: issue.code === 'prefab-hash-mismatch' ? 'hash-mismatch' : 'unknown-prefab',
        severity: 'error',
        message: issue.message,
      })),
    };
  }

  const resolution = resolveGameObjectPrefab(registry, reference);
  const resolutionErrors = resolution.issues.filter((issue) => issue.severity === 'error');
  if (resolutionErrors.length > 0) {
    return { issues: resolutionErrors.map((issue) => ({ code: 'unresolvable-prefab', severity: 'error', message: issue.message })) };
  }
  const nodes = walkResolvedNodes(resolution.prefab.root).filter((node) => node.nodeId === input.nodeId);
  if (nodes.length === 0) return { issues: [{ code: 'unknown-node', severity: 'error', message: `no node "${input.nodeId}"` }] };
  if (nodes.length > 1) return { issues: [{ code: 'ambiguous-node', severity: 'error', message: `node "${input.nodeId}" is contributed more than once` }] };
  const node = nodes[0]!;
  const component = node.components.find((entry) => entry.componentId === input.componentId);
  if (!component) return { issues: [{ code: 'unknown-component', severity: 'error', message: `node "${input.nodeId}" has no component "${input.componentId}"` }] };
  if (component.componentType !== 'animator') return { issues: [{ code: 'non-animator-component', severity: 'error', message: `component "${input.componentId}" is ${component.componentType}, not animator` }] };

  const animator = component as AnimatorComponent;
  const issues: AnimationSubjectIssue[] = [];
  const assignments = [animator.assignment.behavior, animator.assignment.motionSet, animator.assignment.rig, animator.assignment.tuning].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  for (const assignment of assignments) {
    if (!assignment.assetType || !assignment.assetId || !assignment.version || !assignment.contentHash) {
      issues.push({ code: 'invalid-assignment', severity: 'error', message: 'Animator assignment is not exact' });
    } else if (input.animationRegistry && input.animationRegistry.checkReference(assignment).length > 0) {
      issues.push({ code: 'missing-animation-asset', severity: 'error', message: `missing exact animation asset ${assignment.assetId}@${assignment.version}` });
    }
  }
  if (issues.some((issue) => issue.severity === 'error')) return { issues };

  const components = node.components;
  const model = components.find((entry) => entry.componentType === 'model-renderer');
  const capsule = components.find((entry) => entry.componentType === 'capsule-collider');
  const equipmentSockets = components.find((entry) => entry.componentType === 'equipment-sockets');
  if (!model) issues.push({ code: 'missing-presentation', severity: 'warning', message: 'subject has no model; graph editing remains available' });

  const subject: AnimationSubjectDefinition = {
    schemaVersion: 1,
    subjectId: animationSubjectId({ prefab: reference, nodeId: node.nodeId, componentId: animator.componentId }),
    displayName: node.displayName,
    source: { prefab: reference, nodeId: node.nodeId, componentId: animator.componentId },
    animator,
    presentation: {
      ...(model?.componentType === 'model-renderer' ? { model: model.model } : {}),
      ...(capsule?.componentType === 'capsule-collider' ? { capsule: { radius: capsule.radius, height: capsule.height, center: capsule.center } } : {}),
      ...(equipmentSockets?.componentType === 'equipment-sockets' ? { equipmentSockets } : {}),
    },
  };
  return { subject, issues };
}

/** Nested contributors can be previewed, but publication belongs to their source Prefab. */
export function animationSubjectPublicationOwner(subject: AnimationSubjectDefinition): GameObjectPrefabReference {
  return subject.source.prefab;
}
