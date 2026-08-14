import { z } from 'zod';

/** Gate 0 ships exactly three (PLAN.md §12). The registry grows per phase. */
export type FieldKind = 'boolean' | 'string' | 'channel-id';

export interface FieldMetadata {
  field?: FieldKind;
  label?: string;
  description?: string;
  /** Discord channel type numbers to offer, for `channel-id` fields. */
  channelTypes?: number[];
}

/**
 * Typed metadata registry (Zod 4).
 *
 * Preferred over `.meta()` on `z.globalRegistry`, whose `GlobalMeta` is
 * `[k: string]: unknown` — this one is strongly typed, so a typo in a field kind
 * is a compile error rather than a form that silently renders as a text box.
 */
export const protonFields = z.registry<FieldMetadata>();

interface FieldBase {
  /** Dot path into the config object. */
  path: string;
  label: string;
  description?: string;
  optional: boolean;
  defaultValue?: unknown;
}

export interface BooleanField extends FieldBase {
  kind: 'boolean';
}
export interface StringField extends FieldBase {
  kind: 'string';
  minLength?: number;
  maxLength?: number;
}
export interface ChannelIdField extends FieldBase {
  kind: 'channel-id';
  channelTypes?: number[];
}

export type FieldDescriptor = BooleanField | StringField | ChannelIdField;

export class UnsupportedSchemaError extends Error {
  constructor(path: string, detail: string) {
    super(
      `Cannot generate a form field for '${path}': ${detail}. ` +
        'The v1 generator supports boolean, string, channel-id and one level of ' +
        'object nesting (PLAN.md §9). Richer shapes need a bespoke UI.',
    );
    this.name = 'UnsupportedSchemaError';
  }
}

interface Unwrapped {
  inner: z.ZodType;
  optional: boolean;
  defaultValue: unknown;
  metadata: FieldMetadata;
}

/**
 * Strip Optional/Nullable/Default wrappers to reach the base type.
 *
 * Metadata is collected at every level, outermost first, because
 * `.register()` may be called before or after those wrappers and both
 * orderings read naturally at the call site.
 */
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

/** Leaf constraints via Zod's own JSON Schema export rather than internals. */
function constraints(schema: z.ZodType): { minLength?: number; maxLength?: number } {
  try {
    const json = z.toJSONSchema(schema, { io: 'input' }) as {
      minLength?: number;
      maxLength?: number;
    };
    return {
      ...(json.minLength !== undefined ? { minLength: json.minLength } : {}),
      ...(json.maxLength !== undefined ? { maxLength: json.maxLength } : {}),
    };
  } catch {
    return {};
  }
}

/** `welcomeMessage` → `Welcome message`. Sentence case, as UI labels want. */
function humanise(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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

  if (inner instanceof z.ZodBoolean) {
    return [{ ...base, kind: 'boolean' }];
  }

  if (inner instanceof z.ZodString) {
    if (metadata.field === 'channel-id') {
      return [
        {
          ...base,
          kind: 'channel-id',
          ...(metadata.channelTypes !== undefined ? { channelTypes: metadata.channelTypes } : {}),
        },
      ];
    }
    if (metadata.field && metadata.field !== 'string') {
      throw new UnsupportedSchemaError(path, `field kind '${metadata.field}' is not a string type`);
    }
    return [{ ...base, kind: 'string', ...constraints(inner) }];
  }

  throw new UnsupportedSchemaError(path, `unsupported Zod type '${inner.constructor.name}'`);
}

function walk(schema: z.ZodObject<z.ZodRawShape>, prefix: string): FieldDescriptor[] {
  const descriptors: FieldDescriptor[] = [];

  // Object key order is declaration order, so the rendered form matches the
  // schema without anyone maintaining a separate ordering list.
  for (const [key, field] of Object.entries(schema.shape)) {
    descriptors.push(...describeField(key, field as z.ZodType, prefix));
  }

  return descriptors;
}

/**
 * Walk a module's config schema and emit the descriptors the dashboard renders
 * (PLAN.md P4/§9).
 *
 * Throws on anything outside the v1 scope. Failing here — at registry build time,
 * when a module is loaded — rather than at render time means an unsupported
 * schema is caught by the module's own tests instead of producing a blank field
 * in a guild admin's browser.
 */
export function zodToDescriptors(schema: z.ZodObject<z.ZodRawShape>): FieldDescriptor[] {
  return walk(schema, '');
}
