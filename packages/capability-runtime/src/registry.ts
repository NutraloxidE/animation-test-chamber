/**
 * The capability registry, and the completeness rules the harness enforces.
 *
 * The registry itself is small on purpose. Its value is entirely in
 * `checkCapabilityCompleteness`: without that, a manifest is documentation, and
 * documentation is the thing that goes stale first.
 */
import type { ValidationIssue } from '@atc/schema';
import { validateAgainst, type SchemaName, SCHEMA_REGISTRY } from '@atc/schema';
import type {
  CapabilityManifest,
  CommandContext,
  CommandDeclaration,
  CommandResult,
} from './manifest.ts';

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityManifest>();

  register(manifest: CapabilityManifest): void {
    if (this.capabilities.has(manifest.id)) {
      throw new Error(`capability "${manifest.id}" is already registered`);
    }
    this.capabilities.set(manifest.id, manifest);
  }

  /** Registered capabilities, sorted by id so listings are stable. */
  list(): CapabilityManifest[] {
    return [...this.capabilities.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(capabilityId: string): CapabilityManifest | undefined {
    return this.capabilities.get(capabilityId);
  }

  commands(): CommandDeclaration[] {
    return this.list()
      .flatMap((capability) => capability.commands)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  command(commandId: string): CommandDeclaration | undefined {
    return this.commands().find((command) => command.id === commandId);
  }

  /**
   * Validates the input against the command's declared schema, then runs it.
   *
   * Validation is here rather than inside each command so that "every command
   * validates its input" is a property of the registry and not twelve
   * independently forgettable habits.
   */
  execute(commandId: string, input: unknown, context: CommandContext): CommandResult {
    const command = this.command(commandId);
    if (!command) {
      return {
        ok: false,
        issues: [{ path: '/', message: `unknown command "${commandId}"`, keyword: 'reference' }],
      };
    }
    const validation = validateSchema(command.inputSchema, input);
    if (!validation.valid) return { ok: false, issues: validation.issues };
    return command.execute(input, context);
  }
}

/**
 * Ajv-free schema check.
 *
 * `validateAgainst` only knows the named canonical schemas, and command inputs
 * are deliberately not canonical documents — registering every command payload
 * in `SCHEMA_REGISTRY` would put twenty non-canonical shapes into the map that
 * is supposed to be the list of things a repository can contain.
 */
function validateSchema(
  schema: import('@sinclair/typebox').TSchema,
  value: unknown,
): { valid: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  check(schema, value, '', issues);
  return { valid: issues.length === 0, issues };
}

function check(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  const at = path === '' ? '/' : path;

  if (Array.isArray(schema.anyOf)) {
    const anyMatched = (schema.anyOf as Record<string, unknown>[]).some((option) => {
      const nested: ValidationIssue[] = [];
      check(option, value, path, nested);
      return nested.length === 0;
    });
    if (!anyMatched) {
      issues.push({ path: at, message: 'matches no variant of the union', keyword: 'anyOf' });
    }
    return;
  }

  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        issues.push({ path: at, message: 'expected an object', keyword: 'type' });
        return;
      }
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema.required ?? []) as string[];
      for (const key of required) {
        if (!(key in (value as object))) {
          issues.push({ path: at, message: `missing required property "${key}"`, keyword: 'required' });
        }
      }
      for (const [key, nested] of Object.entries(properties)) {
        if (!(key in (value as object))) continue;
        check(nested, (value as Record<string, unknown>)[key], `${path}/${key}`, issues);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value as object)) {
          if (!(key in properties)) {
            issues.push({ path: `${path}/${key}`, message: 'unexpected property', keyword: 'additionalProperties' });
          }
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ path: at, message: 'expected an array', keyword: 'type' });
        return;
      }
      const items = schema.items as Record<string, unknown> | undefined;
      if (items) value.forEach((entry, index) => check(items, entry, `${path}/${index}`, issues));
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ path: at, message: 'expected a string', keyword: 'type' });
        return;
      }
      if (typeof schema.const === 'string' && value !== schema.const) {
        issues.push({ path: at, message: `expected "${schema.const}"`, keyword: 'const' });
      }
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
        issues.push({ path: at, message: `does not match ${schema.pattern}`, keyword: 'pattern' });
      }
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
        issues.push({ path: at, message: `shorter than ${schema.minLength}`, keyword: 'minLength' });
      }
      return;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ path: at, message: 'expected a finite number', keyword: 'type' });
        return;
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        issues.push({ path: at, message: 'expected an integer', keyword: 'type' });
      }
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        issues.push({ path: at, message: `below minimum ${schema.minimum}`, keyword: 'minimum' });
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        issues.push({ path: at, message: `above maximum ${schema.maximum}`, keyword: 'maximum' });
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        issues.push({ path: at, message: 'expected a boolean', keyword: 'type' });
      }
      return;
    }
    default:
      return;
  }
}

export { validateSchema };

export interface CompletenessIssue {
  capabilityId: string;
  message: string;
}

/**
 * The rule that makes a capability a capability.
 *
 * Every branch here corresponds to a way a capability could ship half-finished
 * and still look plausible in a listing: commands with no schema, an authoring
 * field wired to a command nobody implemented, an observation the runtime never
 * emits, a fixture path that was renamed, a harness stage that is not a script.
 */
export function checkCapabilityCompleteness(
  registry: CapabilityRegistry,
  context: {
    /** Repo-relative paths that exist, for fixture checks. */
    fileExists: (path: string) => boolean;
    /** Script names declared in package.json. */
    scripts: ReadonlySet<string>;
  },
): CompletenessIssue[] {
  const issues: CompletenessIssue[] = [];
  const seenCommandIds = new Set<string>();
  const seenSurfaceIds = new Set<string>();

  for (const capability of registry.list()) {
    const fail = (message: string): void => {
      issues.push({ capabilityId: capability.id, message });
    };

    if (capability.commands.length === 0) fail('declares no machine-operable command');
    if (capability.authoringSurfaces.length === 0) fail('declares no human authoring surface');
    if (capability.observations.length === 0) fail('declares no observation');
    if (capability.fixtures.length === 0) fail('declares no fixture');
    if (capability.harnessStages.length === 0) fail('declares no harness stage');

    for (const schemaId of capability.schemaIds) {
      if (!(schemaId in SCHEMA_REGISTRY)) {
        fail(`declares schema "${schemaId}", which is not in SCHEMA_REGISTRY`);
      }
    }

    const commandIds = new Set<string>();
    for (const command of capability.commands) {
      if (seenCommandIds.has(command.id)) fail(`duplicate command id "${command.id}"`);
      seenCommandIds.add(command.id);
      commandIds.add(command.id);
      if (!command.inputSchema) fail(`command "${command.id}" has no input schema`);
      if (!command.outputSchema) fail(`command "${command.id}" has no output schema`);
      if (typeof command.execute !== 'function') {
        fail(`command "${command.id}" has no implementation`);
      }
    }

    const observationIds = new Set(capability.observations.map((entry) => entry.id));

    for (const surface of capability.authoringSurfaces) {
      if (seenSurfaceIds.has(surface.id)) fail(`duplicate authoring surface id "${surface.id}"`);
      seenSurfaceIds.add(surface.id);
      if (surface.capabilityId !== capability.id) {
        fail(`authoring surface "${surface.id}" claims capability "${surface.capabilityId}"`);
      }
      if (surface.fields.length === 0) fail(`authoring surface "${surface.id}" exposes no field`);
      for (const field of surface.fields) {
        if (!commandIds.has(field.commandId)) {
          fail(`field "${field.id}" is backed by unknown command "${field.commandId}"`);
        }
        if (field.observationIds.length === 0) {
          fail(`field "${field.id}" shows no observation`);
        }
        for (const observationId of field.observationIds) {
          if (!observationIds.has(observationId)) {
            fail(`field "${field.id}" reads unknown observation "${observationId}"`);
          }
        }
      }
    }

    for (const fixture of capability.fixtures) {
      if (!context.fileExists(fixture.path)) {
        fail(`fixture "${fixture.id}" points at missing file ${fixture.path}`);
      }
    }

    for (const stage of capability.harnessStages) {
      if (!context.scripts.has(stage.script)) {
        fail(`harness stage "${stage.id}" names unknown script "${stage.script}"`);
      }
    }
  }

  return issues;
}

/** Re-exported so callers can name a canonical schema without a second import. */
export type { SchemaName };
export { validateAgainst };
