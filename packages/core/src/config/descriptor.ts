import { z } from 'zod';
import { parseDuration } from './duration.ts';
import { type JsonValue, jsonValueSchema } from './json.ts';

const showWhenSchema = z.object({ path: z.string(), equals: z.array(z.string()) });

export type ShowWhen = z.infer<typeof showWhenSchema>;

const fieldBaseSchema = z.object({
  path: z.string(),
  label: z.string(),
  description: z.string().optional(),
  optional: z.boolean(),
  defaultValue: jsonValueSchema.optional(),

  array: z.boolean().optional(),

  maxItems: z.number().int().optional(),

  showWhen: showWhenSchema.optional(),
});

type FieldBase = z.infer<typeof fieldBaseSchema>;

export const fieldDescriptorSchema = z.discriminatedUnion('kind', [
  fieldBaseSchema.extend({ kind: z.literal('boolean') }),
  fieldBaseSchema.extend({
    kind: z.literal('string'),
    minLength: z.number().int().optional(),
    maxLength: z.number().int().optional(),
  }),
  fieldBaseSchema.extend({
    kind: z.literal('number'),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  fieldBaseSchema.extend({ kind: z.literal('colour') }),
  fieldBaseSchema.extend({
    kind: z.literal('enum'),
    options: z.array(z.string()),
    optionLabels: z.record(z.string(), z.string()).optional(),
  }),
  fieldBaseSchema.extend({
    kind: z.literal('channel-id'),
    channelTypes: z.array(z.number().int()).optional(),
  }),
  fieldBaseSchema.extend({ kind: z.literal('role-id') }),
  fieldBaseSchema.extend({ kind: z.literal('duration') }),
]);

export type FieldDescriptor = z.infer<typeof fieldDescriptorSchema>;

export type FieldKind = FieldDescriptor['kind'];

export type BooleanField = Extract<FieldDescriptor, { kind: 'boolean' }>;
export type StringField = Extract<FieldDescriptor, { kind: 'string' }>;
export type NumberField = Extract<FieldDescriptor, { kind: 'number' }>;
export type ColourField = Extract<FieldDescriptor, { kind: 'colour' }>;
export type EnumField = Extract<FieldDescriptor, { kind: 'enum' }>;
export type ChannelIdField = Extract<FieldDescriptor, { kind: 'channel-id' }>;
export type RoleIdField = Extract<FieldDescriptor, { kind: 'role-id' }>;
export type DurationField = Extract<FieldDescriptor, { kind: 'duration' }>;

export interface FieldMetadata {
  field?: FieldKind;
  label?: string;
  description?: string;

  channelTypes?: number[];
  showWhen?: ShowWhen;
  optionLabels?: Record<string, string>;
}

export const protonFields = z.registry<FieldMetadata>();

const V1_SCOPE =
  'The v1 generator supports string, number, boolean, colour, enum, channel-id, role-id, ' +
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

function enumOptions(path: string, schema: z.ZodType): string[] | undefined {
  if (!(schema instanceof z.ZodEnum)) return undefined;

  const options: unknown[] = [...schema.options];

  if (!options.every((option): option is string => typeof option === 'string')) {
    throw new UnsupportedSchemaError(path, 'enums must have string values, not numeric ones');
  }

  return options;
}

function assertOptionLabels(
  path: string,
  metadata: FieldMetadata,
  schema: z.ZodType,
  options: readonly string[] | undefined,
): void {
  if (metadata.optionLabels === undefined) return;

  if (options === undefined) {
    throw new UnsupportedSchemaError(
      path,
      `optionLabels was registered on a ${schema.constructor.name}`,
      'Only an enum has options to label.',
    );
  }

  for (const key of Object.keys(metadata.optionLabels)) {
    if (options.includes(key)) continue;

    throw new UnsupportedSchemaError(
      path,
      `optionLabels names '${key}', which is not one of its options`,
      `The options are ${options.join(', ')}.`,
    );
  }
}

function assertShowWhen(descriptors: readonly FieldDescriptor[]): void {
  const byPath = new Map(descriptors.map((descriptor) => [descriptor.path, descriptor]));

  for (const { path, showWhen } of descriptors) {
    if (showWhen === undefined) continue;

    const target = byPath.get(showWhen.path);

    if (target === undefined) {
      throw new UnsupportedSchemaError(
        path,
        `showWhen names '${showWhen.path}', which is not a field of this schema`,
        'showWhen.path is another field of the same config, by its dotted path.',
      );
    }

    if (showWhen.equals.length === 0) {
      throw new UnsupportedSchemaError(
        path,
        `showWhen lists no value of '${showWhen.path}' that would show it`,
        'Give showWhen.equals every option the field should appear for.',
      );
    }

    if (target.kind !== 'enum') continue;

    for (const value of showWhen.equals) {
      if (target.options.includes(value)) continue;

      throw new UnsupportedSchemaError(
        path,
        `showWhen expects '${showWhen.path}' to be '${value}', which is not one of its options`,
        `The options are ${target.options.join(', ')}.`,
      );
    }
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
  const options = enumOptions(path, inner);
  assertOptionLabels(path, metadata, inner, options);

  if (inner instanceof z.ZodBoolean) {
    assertHint(path, metadata, inner, ['boolean']);
    return { ...base, kind: 'boolean' };
  }

  if (inner instanceof z.ZodNumber) {
    assertHint(path, metadata, inner, ['number', 'colour']);

    if (metadata.field === 'colour') return { ...base, kind: 'colour' };
    return { ...base, kind: 'number', ...numberConstraints(inner) };
  }

  if (options !== undefined) {
    assertHint(path, metadata, inner, ['enum']);

    return {
      ...base,
      kind: 'enum',
      options,
      ...(metadata.optionLabels !== undefined ? { optionLabels: metadata.optionLabels } : {}),
    };
  }

  // ZodURL is a string at runtime but not a ZodString subclass, so without naming it here a
  // z.url() field fails schema registration rather than rendering as the text input it is.
  if (inner instanceof z.ZodString || inner instanceof z.ZodURL) {
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

// A default that cannot be written as JSON cannot reach the dashboard at all, so it is a v1-scope
// limit like any other rather than something to discover as a blank field in the browser.
function jsonDefault(path: string, value: unknown): JsonValue {
  const parsed = jsonValueSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  throw new UnsupportedSchemaError(path, `its default value is not JSON (${typeof value})`);
}

function describeField(key: string, schema: z.ZodType, prefix: string): FieldDescriptor[] {
  const path = prefix ? `${prefix}.${key}` : key;
  const { inner, optional, defaultValue, metadata } = unwrap(schema);

  const base: FieldBase = {
    path,
    label: metadata.label ?? humanise(key),
    optional,
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(metadata.showWhen !== undefined ? { showWhen: metadata.showWhen } : {}),
    ...(defaultValue !== undefined ? { defaultValue: jsonDefault(path, defaultValue) } : {}),
  };

  if (inner instanceof z.ZodObject) {
    if (prefix) {
      throw new UnsupportedSchemaError(path, 'objects may nest only one level deep');
    }

    // An object contributes no descriptor of its own, so anything registered on it is dropped on
    // the way to its children — a showWhen written here would have hidden nothing, silently.
    for (const key of ['showWhen', 'optionLabels'] as const) {
      if (metadata[key] === undefined) continue;

      throw new UnsupportedSchemaError(
        path,
        `${key} was registered on '${path}', which is a group of fields rather than a field`,
        `Register ${key} on each field of '${path}' it should govern.`,
      );
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
  const descriptors = walk(schema, '');

  assertShowWhen(descriptors);
  return descriptors;
}
