/**
 * The capability manifest.
 *
 * The invariant this type exists to enforce is not "capabilities are
 * describable" — it is:
 *
 *   A new runtime capability is incomplete if it has no machine path, no human
 *   authoring path, no observation path, or no deterministic verification path.
 *
 * Every one of those four is a required, non-empty field below, and
 * `harness/check-capabilities.ts` fails the build when a declaration points at
 * an implementation id that does not exist. A manifest that could be filled in
 * decoratively would be worse than no manifest: it would make an incomplete
 * capability *look* finished in a listing.
 */
import type { TSchema } from '@sinclair/typebox';
import type { ValidationIssue } from '@atc/schema';

/** Control kinds a human authoring surface can render. */
export type AuthoringControl =
  | { kind: 'number'; min: number; max: number; step: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'vector3'; min: number; max: number; step: number };

export interface AuthoringFieldDeclaration {
  id: string;
  label: string;
  description?: string;
  /**
   * Whether editing this field changes one instance or the definition every
   * instance referencing it shares. This is the distinction the whole world
   * contract is about, so the UI is not allowed to guess it.
   */
  scope: 'instance' | 'shared-definition';
  control: AuthoringControl;
  /** The command that applies this field. Must exist in the same manifest. */
  commandId: string;
  /** Observations shown beside the control. Must exist in the same manifest. */
  observationIds: string[];
}

export interface AuthoringSurfaceDeclaration {
  id: string;
  capabilityId: string;
  title: string;
  fields: AuthoringFieldDeclaration[];
}

export interface CommandDeclaration {
  id: string;
  description: string;
  /** Read-only commands never produce a staged change. */
  mutating: boolean;
  inputSchema: TSchema;
  outputSchema: TSchema;
  /**
   * Input arrives as `unknown` and is narrowed inside the body. The registry
   * has already checked it against `inputSchema`, and a declared parameter type
   * here would look like it was doing that job while checking nothing at all.
   */
  execute: (input: unknown, context: CommandContext) => CommandResult;
}

export interface ObservationDeclaration {
  id: string;
  description: string;
  /** Example of the instance-qualified path this observation is read at. */
  pathExample: string;
}

export interface FixtureDeclaration {
  id: string;
  description: string;
  /** Repo-relative path, so the harness can check the fixture actually exists. */
  path: string;
}

export interface HarnessStageDeclaration {
  id: string;
  /** The package.json script that runs it. */
  script: string;
}

export interface CapabilityManifest {
  id: string;
  version: string;
  description: string;
  /** Names in `SCHEMA_REGISTRY` this capability owns. */
  schemaIds: string[];
  /** Runtime module/class names that implement it. */
  runtimeSystems: string[];
  authoringSurfaces: AuthoringSurfaceDeclaration[];
  commands: CommandDeclaration[];
  observations: ObservationDeclaration[];
  fixtures: FixtureDeclaration[];
  harnessStages: HarnessStageDeclaration[];
}

/**
 * What a command is allowed to touch.
 *
 * Note what is absent: a filesystem, a git adapter, a transaction. A command
 * proposes a document; publishing it stays on the existing validated save path,
 * which is the only path that knows how to be atomic.
 */
export interface CommandContext {
  project: import('@atc/schema').ProjectDefinition;
  /** The world as it currently stands — explicit or synthesized. */
  world: import('@atc/schema').WorldDefinition;
  /**
   * A runtime the caller already owns. Present for in-process observation (the
   * browser, a test); absent over HTTP, where every request is standalone.
   */
  runtime?: import('@atc/world-runtime').WorldRuntime;
  /**
   * The asset registry, so a stateless command can build its own runtime rather
   * than reading one somebody else advanced.
   */
  registry?: import('@atc/animation-asset-runtime').AnimationAssetRegistry;
  /** How the caller identifies itself, for protection decisions. */
  actor?: 'human' | 'ai';
}

export interface CommandResult<Output = unknown> {
  ok: boolean;
  issues: ValidationIssue[];
  output?: Output;
  /**
   * The proposed world. A mutating command returns this instead of writing:
   * the caller stages it, validates it, and publishes it through the same save
   * path a human edit uses.
   */
  stagedWorld?: import('@atc/schema').WorldDefinition;
  /** Canonical paths the staged change touches. */
  changedPaths?: string[];
}
