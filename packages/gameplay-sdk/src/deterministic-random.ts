export function seedFrom(parts: readonly string[]): number {
  let hash = 2166136261;
  for (const char of parts.join(':')) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}
export function deterministicRandom(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => { state += 0x6d2b79f5; let value = state; value = Math.imul(value ^ (value >>> 15), value | 1); value ^= value + Math.imul(value ^ (value >>> 7), value | 61); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}
