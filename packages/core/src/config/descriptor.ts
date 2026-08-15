import { z } from 'zod';
import { parseDuration } from './duration.ts';

export type FieldKind =
  | 'boolean'
  | 'string'
  | 'number'
  | 'enum'
  | 'channel-id'
  | 'role-id'
  | 'duration';

export interface FieldMetadata {
  field?: FieldKind;
  label?: string;
  description?: string;

  channelTypes?: number[];
}

export const protonFields = z.registry<FieldMetadata>();

interface FieldBase {
  path: string;
  label: string;
  description?: string;
  optional: boolean;
  defaultValue?: unknown;

  array?: boolean;

  maxItems?: number;
}

export interface BooleanField extends FieldBase {
  kind: 'boolean';
}
export interface StringField extends FieldBase {
  kind: 'string';
  minLength?: number;
  maxLength?: number;
}
export interface NumberField extends FieldBase {
  kind: 'number';
  min?: number;
  max?: number;
}
export interface EnumField extends FieldBase {
  kind: 'enum';
  options: string[];
}
export interface ChannelIdField extends FieldBase {
  kind: 'channel-id';
  channelTypes?: number[];
}
export interface RoleIdField extends FieldBase {
  kind: 'role-id';
}
export interface DurationField extends FieldBase {
  kind: 'duration';
}

export type FieldDescriptor =
  | BooleanField
  | StringField
  | NumberField
  | EnumField
  | ChannelIdField
  | RoleIdField
  | DurationField;

const V1_SCOPE =
  'The v1 generator supports string, number, boolean, enum, channel-id, role-id, ' +
  'duration and flat arrays of those, with objects nesting one level (PLAN.md §9). ' +
  'Richer shapes — discriminated unions, recursion — need a bespoke UI.';

export class UnsupportedSchemaError extends Error {
  constructor(path: string, detail: string, hint: string = V1_SCOPE) {
    super(`Cannot generate a form field for '${path}': ${detail}. ${hint}`);
    this.name = 'UnsupportedSchemaError';
  }
}

interface Unwrapped {
  inner: z.ZodType;
  optional: boolean;
  defaultValue: unknown;
  metadata: FieldMetadata;
}

function unwrap(schema: z.ZodType): Unwrapped {
  let current: z.ZodType = schema;
  let optional = false;
  let defaultValue: unknown;
  let metadata: FieldMetadata = {};

  for (let depth = 0; depth < 10; depth++) {
    metadata = { ...protonFields.get(current), ...metadata };

    if (current instanceof z.ZodOptional) {
      optional = true;
      current = current.unwrap() as z.ZodType;
    } else if (current instanceof z.ZodNullable) {
      optional = true;
      current = current.unwrap() as z.ZodType;
    } else if (current instanceof z.ZodDefault) {
      defaultValue = current.def.defaultValue;
      current = current.unwrap() as z.ZodType;
    } else {
      break;
    }
  }

  return { inner: current, optional, defaultValue, metadata };
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringConstraints(schema: z.ZodType): { minLength?: number; maxLength?: number } {
  const json = jsonSchemaOf(schema) as { minLength?: number; maxLength?: number };
  return {
    ...(json.minLength !== undefined ? { minLength: json.minLength } : {}),
    ...(json.maxLength !== undefined ? { maxLength: json.maxLength } : {}),
  };
}

function numberConstraints(schema: z.ZodType): { min?: number; max?: number } {
  const json = jsonSchemaOf(schema) as { minimum?: number; maximum?: number };

  const { minimum, maximum } = json;
  return {
    ...(minimum !== undefined && minimum !== -Number.MAX_SAFE_INTEGER ? { min: minimum } : {}),
    ...(maximum !== undefined && maximum !== Number.MAX_SAFE_INTEGER ? { max: maximum } : {}),
  };
}

function humanise(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function assertHint(
  path: string,
  metadata: FieldMetadata,
  schema: z.ZodType,
  allowed: readonly FieldKind[],
): void {
  if (metadata.field !== undefined && !allowed.includes(metadata.field)) {
    throw new UnsupportedSchemaError(
      path,
      `field kind '${metadata.field}' cannot be built from a ${schema.constructor.name}`,
    );
  }
}

function assertDurationDefault(path: string, defaultValue: unknown): void {
  if (defaultValue === undefined || defaultValue === null) return;

  for (const value of Array.isArray(defaultValue) ? defaultValue : [defaultValue]) {
    if (typeof value !== 'string') continue;
    try {
      parseDuration(value);
    } catch {
      throw new UnsupportedSchemaError(
        path,
        `its default ${JSON.stringify(value)} is not a valid duration`,
        'Use a number followed by s, m, h, d or w — for example 30m, 12h or 7d.',
      );
    }
  }
}

function leafField(
  path: string,
  base: FieldBase,
  inner: z.ZodType,
  metadata: FieldMetadata,
): FieldDescriptor {
  if (inner instanceof z.ZodBoolean) {
    assertHint(path, metadata, inner, ['boolean']);
    return { ...base, kind: 'boolean' };
  }

  if (inner instanceof z.ZodNumber) {
    assertHint(path, metadata, inner, ['number']);
    return { ...base, kind: 'number', ...numberConstraints(inner) };
  }

  if (inner instanceof z.ZodEnum) {
    assertHint(path, metadata, inner, ['enum']);
    const options: unknown[] = [...inner.options];

    if (!options.every((option): option is string => typeof option === 'string')) {
      throw new UnsupportedSchemaError(path, 'enums must have string values, not numeric ones');
    }
    return { ...base, kind: 'enum', options };
  }

  if (inner instanceof z.ZodString) {
    assertHint(path, metadata, inner, ['string', 'channel-id', 'role-id', 'duration']);

    switch (metadata.field) {
      case 'channel-id':
        return {
          ...base,
          kind: 'channel-id',
          ...(metadata.channelTypes !== undefined ? { channelTypes: metadata.channelTypes } : {}),
        };
      case 'role-id':
        return { ...base, kind: 'role-id' };
      case 'duration':
        assertDurationDefault(path, base.defaultValue);
        return { ...base, kind: 'duration' };
      default:
        return { ...base, kind: 'string', ...stringConstraints(inner) };
    }
  }

  throw new UnsupportedSchemaError(path, `unsupported Zod type '${inner.constructor.name}'`);
}

function describeField(key: string, schema: z.ZodType, prefix: string): FieldDescriptor[] {
  const path = prefix ? `${prefix}.${key}` : key;
  const { inner, optional, defaultValue, metadata } = unwrap(schema);

  const base: FieldBase = {
    path,
    label: metadata.label ?? humanise(key),
    optional,
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  };

  if (inner instanceof z.ZodObject) {
    if (prefix) {
      throw new UnsupportedSchemaError(path, 'objects may nest only one level deep');
    }
    return walk(inner as z.ZodObject<z.ZodRawShape>, path);
  }

  if (inner instanceof z.ZodArray) {
    const element = unwrap(inner.element as z.ZodType);

    if (element.inner instanceof z.ZodArray || element.inner instanceof z.ZodObject) {
      throw new UnsupportedSchemaError(
        path,
        'arrays must be flat — of scalars, not arrays or objects',
      );
    }

    const merged = { ...element.metadata, ...metadata };
    const { maxItems } = jsonSchemaOf(inner) as { maxItems?: number };

    return [
      leafField(
        path,
        { ...base, array: true, ...(maxItems !== undefined ? { maxItems } : {}) },
        element.inner,
        merged,
      ),
    ];
  }

  return [leafField(path, base, inner, metadata)];
}

function walk(schema: z.ZodObject<z.ZodRawShape>, prefix: string): FieldDescriptor[] {
  const descriptors: FieldDescriptor[] = [];

  for (const [key, field] of Object.entries(schema.shape)) {
    descriptors.push(...describeField(key, field as z.ZodType, prefix));
  }

  return descriptors;
}

export function zodToDescriptors(schema: z.ZodObject<z.ZodRawShape>): FieldDescriptor[] {
  return walk(schema, '');
}
