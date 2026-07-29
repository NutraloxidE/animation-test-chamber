import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectDefinition } from '@atc/schema';

const PROJECT_PATH = resolve(__dirname, '../../projects/demo-character/project.json');

/**
 * Loads the canonical demo project. Tests read the real file rather than a
 * hand-built fixture so a schema or data change cannot pass the suite while
 * breaking the thing the app actually loads.
 */
export function loadDemoProject(): ProjectDefinition {
  return JSON.parse(readFileSync(PROJECT_PATH, 'utf8')) as ProjectDefinition;
}

/** Deep clone, so a test mutating a document cannot leak into the next test. */
export function cloneProject(project: ProjectDefinition): ProjectDefinition {
  return structuredClone(project);
}
