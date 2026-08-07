import type { JsonObject } from '@atc/schema';
import type { PropertyDescriptor, PropertyMap } from './property.ts';

export interface GameplayValidationIssue { code: 'unknown-property' | 'missing-property' | 'invalid-value'; path: string; message: string }

function valid(descriptor: PropertyDescriptor<unknown>, value: unknown): boolean {
  if (descriptor.kind === 'number') return typeof value === 'number' && Number.isFinite(value) && (descriptor.min === undefined || value >= descriptor.min) && (descriptor.max === undefined || value <= descriptor.max);
  if (descriptor.kind === 'boolean') return typeof value === 'boolean';
  if (descriptor.kind === 'string') return typeof value === 'string';
  if (descriptor.kind === 'enum') return typeof value === 'string' && Boolean(descriptor.values?.includes(value));
  if (descriptor.kind === 'vec3') return value !== null && typeof value === 'object' && Object.keys(value).length === 3 && ['x','y','z'].every((key) => typeof (value as Record<string, unknown>)[key] === 'number' && Number.isFinite((value as Record<string, unknown>)[key]));
  return value !== null && typeof value === 'object' && Object.keys(value).length === 1 && typeof (value as Record<string, unknown>).gameObjectId === 'string';
}

export function validateProperties(schema: PropertyMap, properties: JsonObject): GameplayValidationIssue[] {
  const issues: GameplayValidationIssue[] = [];
  for (const key of Object.keys(properties)) if (!schema[key]) issues.push({ code: 'unknown-property', path: `/${key}`, message: `unknown property "${key}"` });
  for (const [key, descriptor] of Object.entries(schema)) {
    const value = properties[key];
    if (value === undefined) { if (descriptor.required) issues.push({ code: 'missing-property', path: `/${key}`, message: `missing required property "${key}"` }); }
    else if (!valid(descriptor, value)) issues.push({ code: 'invalid-value', path: `/${key}`, message: `invalid ${descriptor.kind} value for "${key}"` });
  }
  return issues;
}

export function authoredProperties(schema: PropertyMap, provided: JsonObject = {}): JsonObject {
  const result: JsonObject = {};
  for (const [key, descriptor] of Object.entries(schema)) if (descriptor.default !== undefined) result[key] = descriptor.default as JsonObject[string];
  return { ...result, ...provided };
}
