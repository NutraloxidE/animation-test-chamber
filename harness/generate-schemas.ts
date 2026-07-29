/**
 * Emits the generated views of canonical data:
 *   schemas/*.json          JSON Schema for each registered type
 *   presets/terrain/*.json  the terrain presets, for the Unity bundle
 *
 * Both are regenerable artifacts, never sources of truth. `harness:check`
 * regenerates them in memory and fails if the committed files differ, which is
 * how schema drift is caught.
 */
import { SCHEMA_REGISTRY } from '@atc/schema';
import { TERRAIN_PRESETS } from '@atc/terrain-runtime';
import { writeRepoFile } from './lib.ts';

export interface GeneratedFile {
  path: string;
  content: string;
}

export function buildGeneratedFiles(): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  for (const [name, schema] of Object.entries(SCHEMA_REGISTRY)) {
    files.push({
      path: `schemas/${name}.schema.json`,
      content: `${JSON.stringify(
        { $schema: 'http://json-schema.org/draft-07/schema#', ...schema },
        null,
        2,
      )}\n`,
    });
  }

  for (const preset of TERRAIN_PRESETS) {
    files.push({
      path: `presets/terrain/${preset.id}.json`,
      content: `${JSON.stringify(preset, null, 2)}\n`,
    });
  }

  files.push({
    path: 'schemas/README.md',
    content: `# Generated JSON Schemas

Do not edit these files. They are generated from the TypeBox definitions in
\`packages/schema/src\` by \`pnpm schema:generate\`.

The TypeScript definitions are canonical. These JSON Schemas exist so external
tools — the Unity importer, editors, CI validators — can consume the same
contract without a TypeScript toolchain.

\`pnpm harness:check\` regenerates them and fails if the committed copies differ.
`,
  });

  return files;
}

function main(): void {
  const files = buildGeneratedFiles();
  for (const file of files) writeRepoFile(file.path, file.content);
  console.log(`wrote ${files.length} generated file(s)`);
}

// Only write when invoked directly; the check stage imports buildGeneratedFiles.
if (process.argv[1]?.includes('generate-schemas')) main();
