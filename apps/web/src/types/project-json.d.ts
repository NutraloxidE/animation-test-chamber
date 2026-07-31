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

/**
 * The generated animation asset library.
 *
 * The project only holds references now, so the chamber cannot render without
 * the assets they point at. Importing the generated index is what keeps the
 * static build working: a host with no API still gets a full registry, and the
 * Asset Library degrades by losing the ability to *write*, not to look.
 */
declare module '@chamber/animation-assets' {
  import type { AnimationAssetLibraryIndex } from '@atc/animation-asset-runtime';
  const index: AnimationAssetLibraryIndex;
  export default index;
}
