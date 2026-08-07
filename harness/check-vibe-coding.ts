import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const required = ['DECISIONS/0028-gameplay-script-is-the-typed-game-extension-abi.md', 'agents/GAMEPLAY_VIBE_CODING.md', 'agents/skills/add-gameplay-script.md', 'agents/skills/build-gameplay-feature.md', 'agents/handoffs/gameplay-vibe-coding-platform.md'];
for (const path of required) if (!existsSync(resolve(root, path))) throw new Error(`vibe-coding: missing ${path}`);
const scripts = readdirSync(resolve(root, 'packages/gameplay/src/scripts'), { recursive: true }).filter((path) => String(path).endsWith('.ts'));
if (scripts.length < 2) throw new Error('vibe-coding: Health and Stamina proof scripts are required');
const runtime = readFileSync(resolve(root, 'packages/game-object-runtime/src/components.ts'), 'utf8');
for (const id of ['health', 'stamina']) if (runtime.includes(`'${id}'`) || runtime.includes(`"${id}"`)) throw new Error(`vibe-coding: engine manually registers ${id}`);
const generator = readFileSync(resolve(root, 'harness/generate-gameplay-registry.ts'), 'utf8');
if (!generator.includes('readdir')) throw new Error('vibe-coding: registry discovery is not generated from files');
console.log(`VIBE CODING: PASS (${scripts.length} scripts discovered without engine registration)`);
