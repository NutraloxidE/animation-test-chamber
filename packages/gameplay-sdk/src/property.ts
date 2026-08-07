export type PropertyKind = 'number' | 'boolean' | 'string' | 'enum' | 'vec3' | 'gameObjectRef';

export interface PropertyDescriptor<T> {
  kind: PropertyKind;
  default?: T;
  required: boolean;
  instanceOverride: boolean;
  min?: number;
  max?: number;
  step?: number;
  values?: readonly string[];
}

type Options<T> = Omit<PropertyDescriptor<T>, 'kind' | 'required' | 'instanceOverride'> & {
  required?: boolean;
  instanceOverride?: boolean;
};

function prop<T>(kind: PropertyKind, options: Options<T> = {}): PropertyDescriptor<T> {
  return { kind, required: options.required ?? true, instanceOverride: options.instanceOverride ?? false, ...options };
}

export const numberProp = (options: Options<number> = {}) => prop('number', options);
export const booleanProp = (options: Options<boolean> = {}) => prop('boolean', options);
export const stringProp = (options: Options<string> = {}) => prop('string', options);
export const enumProp = <T extends string>(values: readonly T[], options: Options<T> = {}) => prop('enum', { ...options, values }) as PropertyDescriptor<T>;
export const vec3Prop = (options: Options<{ x: number; y: number; z: number }> = {}) => prop('vec3', options);
export const gameObjectRefProp = (options: Options<{ gameObjectId: string }> = {}) => prop('gameObjectRef', options);

export type PropertyMap = Record<string, PropertyDescriptor<unknown>>;
export type PropertiesOf<T extends PropertyMap> = { [K in keyof T]: T[K] extends PropertyDescriptor<infer V> ? V : never };
