import type { TSchema } from '@sinclair/typebox';

/**
 * Generates Unity-compatible C# DTOs from the same TypeBox schemas the web app
 * validates against, so the two cannot drift silently. Emitted types target
 * Unity's JsonUtility: public fields, [Serializable], List<T> for arrays.
 *
 * Discriminated unions (TerrainFeature) are flattened into one struct with a
 * `kind` field and the union of members. That is a deliberate limitation of
 * JsonUtility, and it is stated in the generated header rather than hidden.
 */

interface JsonSchemaNode {
  /** TypeBox keeps the declared name here; it becomes the C# type name. */
  $id?: string;
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

interface EmittedClass {
  name: string;
  lines: string[];
}

/**
 * C# keywords, which cannot be bare field names.
 *
 * The list started as the handful the schemas happened to use and grew the
 * moment a Prefab gained an `abstract` flag — a field name that produced C#
 * which does not compile, in a file nothing in this repository compiles. A
 * partial list is a trap that springs on whoever adds the next field, so this
 * is the whole set rather than the fields in use today.
 */
const RESERVED = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked',
  'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else',
  'enum', 'event', 'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for',
  'foreach', 'goto', 'if', 'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock',
  'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params',
  'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short',
  'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true',
  'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort', 'using', 'virtual',
  'void', 'volatile', 'while',
]);

function pascalCase(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]+(.)?/g, (_, chr: string | undefined) => (chr ? chr.toUpperCase() : ''))
    .replace(/^[a-z]/, (chr) => chr.toUpperCase());
}

function fieldName(name: string): string {
  return RESERVED.has(name) ? `@${name}` : name;
}

/** True when every branch of a union is a string literal. */
function stringLiteralUnion(node: JsonSchemaNode): string[] | null {
  if (!node.anyOf) return null;
  const values: string[] = [];
  for (const branch of node.anyOf) {
    if (typeof branch.const === 'string') values.push(branch.const);
    else return null;
  }
  return values.length > 0 ? values : null;
}

/** True when the union is a discriminated object union (has a `kind` const). */
function objectUnion(node: JsonSchemaNode): JsonSchemaNode[] | null {
  if (!node.anyOf) return null;
  const objects = node.anyOf.filter((branch) => branch.type === 'object' && branch.properties);
  return objects.length === node.anyOf.length && objects.length > 0 ? objects : null;
}

class CSharpEmitter {
  private readonly classes = new Map<string, EmittedClass>();
  private readonly enums = new Map<string, string[]>();

  emitRoot(name: string, schema: TSchema): void {
    this.emitType(name, schema as JsonSchemaNode);
  }

  /**
   * A schema's own `$id` wins over the name derived from where it appears, so a
   * TransitionDefinition nested inside AnimationGraphDefinition emits as
   * `TransitionDefinition` rather than `AnimationGraphDefinitionTransitionsItem`
   * — and the second occurrence reuses the first class instead of duplicating it.
   */
  private emitType(name: string, node: JsonSchemaNode): string {
    return this.emitNamed(node.$id ?? name, node);
  }

  private emitNamed(name: string, node: JsonSchemaNode): string {
    const literals = stringLiteralUnion(node);
    if (literals) {
      // Unity's JsonUtility cannot deserialize C# enums from strings reliably,
      // so string-literal unions stay as string fields with the legal values
      // documented next to them.
      return `string /* ${literals.join(' | ')} */`;
    }

    if (node.anyOf) {
      const objects = objectUnion(node);
      if (objects) {
        return this.emitFlattenedUnion(name, objects);
      }
      // Mixed primitive union: fall back to string, which JsonUtility can hold.
      return 'string';
    }

    if (node.type === 'array' && node.items) {
      const itemType = this.emitType(`${name}Item`, node.items);
      return `List<${itemType}>`;
    }

    if (node.type === 'object' && node.properties) {
      return this.emitClass(name, node);
    }

    if (node.type === 'integer') return 'int';
    if (node.type === 'number') return 'float';
    if (node.type === 'boolean') return 'bool';
    if (node.type === 'string') return 'string';
    if (Array.isArray(node.type) && node.type.includes('null')) return 'string';

    return 'string';
  }

  private emitClass(name: string, node: JsonSchemaNode): string {
    const className = pascalCase(name);
    if (this.classes.has(className)) return className;

    // Reserve the name before recursing so self-references terminate.
    this.classes.set(className, { name: className, lines: [] });

    const lines: string[] = [];
    for (const [property, child] of Object.entries(node.properties ?? {})) {
      const type = this.emitType(`${className}${pascalCase(property)}`, child);
      const required = node.required?.includes(property) ?? false;
      if (!required) lines.push(`        // optional`);
      lines.push(`        public ${type} ${fieldName(property)};`);
    }

    this.classes.set(className, { name: className, lines });
    return className;
  }

  private emitFlattenedUnion(name: string, branches: JsonSchemaNode[]): string {
    const className = pascalCase(name);
    if (this.classes.has(className)) return className;
    this.classes.set(className, { name: className, lines: [] });

    const merged = new Map<string, JsonSchemaNode>();
    for (const branch of branches) {
      for (const [property, child] of Object.entries(branch.properties ?? {})) {
        if (!merged.has(property)) merged.set(property, child);
      }
    }

    const lines: string[] = [
      '        // Flattened discriminated union: check `kind` before reading the',
      '        // other fields. Unity JsonUtility cannot express polymorphism.',
    ];
    for (const [property, child] of merged) {
      const type = this.emitType(`${className}${pascalCase(property)}`, child);
      lines.push(`        public ${type} ${fieldName(property)};`);
    }

    this.classes.set(className, { name: className, lines });
    return className;
  }

  render(namespace: string, header: string): string {
    const out: string[] = [];
    out.push('// <auto-generated>');
    out.push(`// ${header}`);
    out.push('// Generated from the TypeBox schemas in packages/schema.');
    out.push('// Do not edit by hand: regenerate with `pnpm unity:export`.');
    out.push('// </auto-generated>');
    out.push('using System;');
    out.push('using System.Collections.Generic;');
    out.push('');
    out.push(`namespace ${namespace}`);
    out.push('{');

    for (const [name, values] of this.enums) {
      out.push(`    public static class ${name}Values`);
      out.push('    {');
      for (const value of values) {
        out.push(`        public const string ${pascalCase(value)} = "${value}";`);
      }
      out.push('    }');
      out.push('');
    }

    for (const emitted of this.classes.values()) {
      out.push('    [Serializable]');
      out.push(`    public class ${emitted.name}`);
      out.push('    {');
      out.push(...emitted.lines);
      out.push('    }');
      out.push('');
    }

    out.push('}');
    return out.join('\n');
  }

  addConstants(name: string, values: string[]): void {
    this.enums.set(name, values);
  }
}

export function generateCSharpDtos(
  roots: Record<string, TSchema>,
  constants: Record<string, string[]> = {},
  namespace = 'AnimationTestChamber.Generated',
): string {
  const emitter = new CSharpEmitter();
  for (const [name, values] of Object.entries(constants)) {
    emitter.addConstants(name, values);
  }
  for (const [name, schema] of Object.entries(roots)) {
    emitter.emitRoot(name, schema);
  }
  return emitter.render(namespace, 'Animation Test Chamber canonical data transfer objects.');
}
