import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from './lib.ts';

const root = resolve(import.meta.dirname, '..');
const sdk = readFileSync(resolve(root, 'packages/gameplay-sdk/src/types.ts'), 'utf8');
const runtime = readFileSync(resolve(root, 'packages/game-object-runtime/src/scene.ts'), 'utf8');
const airDash = readFileSync(resolve(root, 'packages/gameplay/src/scripts/air-dash/1.0.0.ts'), 'utf8');
for (const token of ['impulse', 'motion-override', 'movement-scale', 'teleport', 'GameplayCharacterApi']) if (!sdk.includes(token)) throw new Error(`character-motion: SDK is missing ${token}`);
if (!runtime.includes('simulation-owned')) throw new Error('character-motion: direct CharacterMotor transform mutation is not refused');
if (!airDash.includes("character.command") || runtime.includes("'air-dash'")) throw new Error('character-motion: Air Dash must remain Script-only');
const result = run('npx', ['vitest', 'run', 'tests/unit/character-motion']);
if (result.code !== 0) throw new Error(result.output);
console.log('CHARACTER MOTION: PASS');
