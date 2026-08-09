export function deterministicBlendWeights(
  previousTakeKey: string | undefined,
  currentTakeKey: string,
  blendWeight: number,
): { previous: number; current: number } {
  if (previousTakeKey === currentTakeKey) return { previous: 0, current: 1 };
  return { previous: 1 - blendWeight, current: blendWeight };
}
