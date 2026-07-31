/**
 * Compatibility validation (PLAN 18, 31).
 *
 * Every check here answers the same question in a different place: *will this
 * combination actually play?* The plan is explicit that the answer must arrive
 * before the engine starts, not as a missing clip at tick 400, so all of it is
 * pure and runs during project load.
 */
import type {
  AnimationBehaviorAsset,
  AnimationMotionSetAsset,
  AssetIssue,
  AssetReference,
  HumanoidRigProfileAsset,
  MotionSlotDefinition,
  RetargetStatus,
} from '@atc/schema';
import type { AnimationAssetRegistry } from './registry.ts';

/**
 * Retarget status for a clip authored on `clipRig` played on `characterRig`.
 *
 * The MVP does not implement retargeting. What it does implement is refusing to
 * pretend: a `conversion-required` pair is never played silently, and the UI is
 * given the reason rather than an empty viewport.
 */
export function retargetStatusBetween(
  clipRig: HumanoidRigProfileAsset,
  characterRig: HumanoidRigProfileAsset,
): RetargetStatus {
  if (clipRig.compatibilityKey === characterRig.compatibilityKey) return 'direct-compatible';

  const required = ['hips', 'leftFoot', 'rightFoot'] as const;
  const mappedOnBoth = required.every(
    (bone) => Boolean(clipRig.humanoidBones[bone]) && Boolean(characterRig.humanoidBones[bone]),
  );
  const sameCoordinateSystem =
    clipRig.coordinateSystem.upAxis === characterRig.coordinateSystem.upAxis &&
    clipRig.coordinateSystem.forwardAxis === characterRig.coordinateSystem.forwardAxis &&
    clipRig.coordinateSystem.handedness === characterRig.coordinateSystem.handedness;

  return mappedOnBoth && sameCoordinateSystem ? 'retarget-compatible' : 'conversion-required';
}

export function describeIncompatibility(
  clipRig: HumanoidRigProfileAsset,
  characterRig: HumanoidRigProfileAsset,
): string {
  const parts: string[] = [];
  if (clipRig.coordinateSystem.forwardAxis !== characterRig.coordinateSystem.forwardAxis) {
    parts.push(
      `forward axis ${clipRig.coordinateSystem.forwardAxis} vs ${characterRig.coordinateSystem.forwardAxis}`,
    );
  }
  if (clipRig.coordinateSystem.handedness !== characterRig.coordinateSystem.handedness) {
    parts.push('opposite handedness');
  }
  for (const bone of ['hips', 'leftFoot', 'rightFoot'] as const) {
    if (!clipRig.humanoidBones[bone]) parts.push(`${clipRig.metadata.id} has no ${bone} mapping`);
    if (!characterRig.humanoidBones[bone]) {
      parts.push(`${characterRig.metadata.id} has no ${bone} mapping`);
    }
  }
  if (parts.length === 0) parts.push(`different skeletons (${clipRig.compatibilityKey} vs ${characterRig.compatibilityKey})`);
  return parts.join('; ');
}

/** Fallback chains must terminate. A cycle would hang slot resolution. */
export function fallbackCycles(slots: readonly MotionSlotDefinition[]): string[][] {
  const bySlot = new Map(slots.map((slot) => [slot.id, slot]));
  const cycles: string[][] = [];
  const settled = new Set<string>();

  for (const slot of slots) {
    if (settled.has(slot.id)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let current: MotionSlotDefinition | undefined = slot;
    while (current) {
      if (onPath.has(current.id)) {
        cycles.push([...path.slice(path.indexOf(current.id)), current.id]);
        break;
      }
      path.push(current.id);
      onPath.add(current.id);
      current = current.fallbackSlot ? bySlot.get(current.fallbackSlot) : undefined;
    }
    for (const id of path) settled.add(id);
  }
  return cycles;
}

export interface MotionSetCompatibility {
  compatible: boolean;
  issues: AssetIssue[];
  /** Required slots the set does not bind, directly or through a fallback. */
  missingSlots: string[];
  /** Slots bound by the set that the behaviour never asks for. */
  unusedBindings: string[];
  retargetStatus: RetargetStatus;
}

/**
 * Can this motion set drive this behaviour, on this character's rig?
 *
 * `characterRig` is separate from the set's own rig on purpose: a set is
 * authored *for* a rig, and the question of whether the character can wear it
 * is a different one from whether the set is internally consistent.
 */
export function checkMotionSetCompatibility(
  registry: AnimationAssetRegistry,
  behavior: AnimationBehaviorAsset,
  motionSet: AnimationMotionSetAsset,
  characterRigReference: AssetReference,
): MotionSetCompatibility {
  const issues: AssetIssue[] = [];
  const motionSetReference: AssetReference = {
    assetType: 'animation-motion-set',
    assetId: motionSet.metadata.id,
    version: motionSet.metadata.version,
    contentHash: motionSet.metadata.contentHash,
  };

  const boundSlots = new Set(motionSet.bindings.map((binding) => binding.motionSlot));
  const fallbackFor = new Map(
    motionSet.fallbackBindings.map((entry) => [entry.missingSlot, entry.fallbackSlot]),
  );

  const resolvesTo = (slotId: string, depth = 0): boolean => {
    if (depth > 8) return false;
    if (boundSlots.has(slotId)) return true;
    const slot = behavior.motionSlots.find((entry) => entry.id === slotId);
    const next = fallbackFor.get(slotId) ?? slot?.fallbackSlot;
    return next ? resolvesTo(next, depth + 1) : false;
  };

  const missingSlots: string[] = [];
  for (const slot of behavior.motionSlots) {
    if (!slot.required) continue;
    if (!resolvesTo(slot.id)) {
      missingSlots.push(slot.id);
      issues.push({
        code: 'missing-required-motion-slot',
        severity: 'error',
        message: `motion set "${motionSet.metadata.id}" does not bind required slot "${slot.id}"`,
        path: `/motionSlots/${slot.id}`,
        reference: motionSetReference,
      });
    }
  }

  for (const cycle of fallbackCycles(behavior.motionSlots)) {
    issues.push({
      code: 'invalid-fallback-cycle',
      severity: 'error',
      message: `motion slot fallback loops: ${cycle.join(' -> ')}`,
      reference: motionSetReference,
    });
  }

  const behaviorSlots = new Set(behavior.motionSlots.map((slot) => slot.id));
  const unusedBindings = [...boundSlots].filter((slot) => !behaviorSlots.has(slot));

  if (
    motionSet.compatibleBehaviorIds.length > 0 &&
    !motionSet.compatibleBehaviorIds.includes(behavior.metadata.id)
  ) {
    issues.push({
      code: 'motion-set-behavior-incompatible',
      severity: 'warning',
      message:
        `motion set "${motionSet.metadata.id}" does not list behaviour "${behavior.metadata.id}" ` +
        `as compatible, though every required slot is bound`,
      reference: motionSetReference,
    });
  }

  // Duplicate (slot, context) pairs would make resolution order-dependent.
  const seenBindings = new Set<string>();
  for (const binding of motionSet.bindings) {
    const key = `${binding.motionSlot}::${binding.contextualKey ?? ''}`;
    if (seenBindings.has(key)) {
      issues.push({
        code: 'duplicate-binding',
        severity: 'error',
        message: `slot "${binding.motionSlot}" is bound twice for context "${binding.contextualKey ?? 'default'}"`,
        reference: motionSetReference,
      });
    }
    seenBindings.add(key);
  }

  let retargetStatus: RetargetStatus = 'direct-compatible';
  const rigIssues = registry.checkReference(characterRigReference);
  const setRigIssues = registry.checkReference(motionSet.rig);
  if (rigIssues.length > 0 || setRigIssues.length > 0) {
    issues.push(...rigIssues, ...setRigIssues);
  } else {
    const characterRig = registry.getRig(characterRigReference);
    const clipRig = registry.getRig(motionSet.rig);
    retargetStatus = retargetStatusBetween(clipRig, characterRig);
    if (retargetStatus === 'conversion-required') {
      issues.push({
        code: 'clip-rig-incompatible',
        severity: 'error',
        message:
          `clips in "${motionSet.metadata.id}" are authored for rig "${clipRig.metadata.id}" and ` +
          `cannot play on "${characterRig.metadata.id}": ${describeIncompatibility(clipRig, characterRig)}`,
        reference: motionSetReference,
      });
    }
  }

  // Every clip must itself accept the rig it is about to be played on.
  for (const binding of motionSet.bindings) {
    const clipIssues = registry.checkReference(binding.clip);
    if (clipIssues.length > 0) {
      issues.push(...clipIssues);
      continue;
    }
    const clip = registry.getClip(binding.clip);
    if (
      clip.compatibleRigIds.length > 0 &&
      !clip.compatibleRigIds.includes(characterRigReference.assetId)
    ) {
      issues.push({
        code: 'clip-rig-incompatible',
        severity: 'warning',
        message:
          `clip "${clip.metadata.id}" does not list rig "${characterRigReference.assetId}" as compatible`,
        reference: binding.clip,
      });
    }
  }

  // Required semantic events must be emitted by something the set binds.
  const emitted = new Set<string>();
  for (const binding of motionSet.bindings) {
    if (registry.checkReference(binding.clip).length > 0) continue;
    for (const event of registry.getClip(binding.clip).clip.events) emitted.add(event.kind);
  }
  for (const contract of behavior.semanticEvents) {
    if (!contract.required || emitted.has(contract.kind)) continue;
    issues.push({
      code: 'missing-semantic-event',
      severity: 'warning',
      message:
        `behaviour "${behavior.metadata.id}" requires the ${contract.kind} event, which no clip ` +
        `in "${motionSet.metadata.id}" emits`,
      reference: motionSetReference,
    });
  }

  return {
    compatible: !issues.some((issue) => issue.severity === 'error'),
    issues,
    missingSlots,
    unusedBindings,
    retargetStatus,
  };
}
