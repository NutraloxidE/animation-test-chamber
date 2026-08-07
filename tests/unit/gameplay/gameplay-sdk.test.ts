import { describe, expect, it } from 'vitest';
import { authoredProperties, deterministicRandom, numberProp, seedFrom, validateProperties } from '@atc/gameplay-sdk';

describe('gameplay SDK', () => {
  const schema = { maxHp: numberProp({ default: 100, min: 1, max: 1000 }), regen: numberProp({ min: 0 }) };

  it('refuses unknown, missing, non-finite, and out-of-range properties', () => {
    expect(validateProperties(schema, { maxHp: Number.NaN, typo: 1 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown-property' }),
      expect.objectContaining({ code: 'missing-property' }),
      expect.objectContaining({ code: 'invalid-value' }),
    ]));
    expect(validateProperties(schema, { maxHp: 100, regen: -1 })).toContainEqual(expect.objectContaining({ code: 'invalid-value', path: '/regen' }));
  });

  it('uses defaults only while authoring and validates persisted data strictly', () => {
    expect(authoredProperties(schema, { regen: 2 })).toEqual({ maxHp: 100, regen: 2 });
    expect(validateProperties(schema, { regen: 2 })).toContainEqual(expect.objectContaining({ code: 'missing-property', path: '/maxHp' }));
  });

  it('repeats the same deterministic random stream', () => {
    const seed = seedFrom(['scene', 'object', 'script']);
    const first = deterministicRandom(seed);
    const second = deterministicRandom(seed);
    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });
});
