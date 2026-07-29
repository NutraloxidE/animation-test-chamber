/**
 * The canonical project is imported directly so the chamber renders on a fresh
 * clone even before the API server is running. The API remains the authority for
 * anything that writes; this import is the read-only starting point.
 */
declare module '@chamber/project' {
  import type { ProjectDefinition } from '@atc/schema';
  const project: ProjectDefinition;
  export default project;
}
