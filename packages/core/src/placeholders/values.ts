import { z } from 'zod';
import { isHttpUrl } from './format.ts';
import { PLACEHOLDER_LIMITS, type TemplateField, URL_MAX } from './limits.ts';

export const SCALAR_TYPES = [
  'text',
  'markdown',
  'mention',
  'url',
  'image_url',
  'integer',
  'number',
  'percent',
  'boolean',
  'datetime',
  'duration',
] as const;

export const scalarTypeSchema = z.enum(SCALAR_TYPES);

export type ScalarType = z.infer<typeof scalarTypeSchema>;

export const placeholderTypeSchema = z.union([
  scalarTypeSchema,
  z.templateLiteral(['list<', scalarTypeSchema, '>']),
]);

export type PlaceholderType = z.infer<typeof placeholderTypeSchema>;

export type FlowType = PlaceholderType | 'formatted';

export const MENTION_MARKUP = /^<(?:@!?|@&|#)\d{17,20}>$/;

const DATE_MS_MAX = 8_640_000_000_000_000;

const link = z.string().max(URL_MAX).refine(isHttpUrl, 'must be an http or https link');

export const scalarValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: z.string() }),
  z.object({ type: z.literal('markdown'), value: z.string() }),
  z.object({
    type: z.literal('mention'),
    value: z.string().regex(MENTION_MARKUP, 'must be user, role or channel mention markup'),
    name: z.string().optional(),
  }),
  z.object({ type: z.literal('url'), value: link }),
  z.object({ type: z.literal('image_url'), value: link }),
  z.object({ type: z.literal('integer'), value: z.int() }),
  z.object({ type: z.literal('number'), value: z.number() }),
  z.object({ type: z.literal('percent'), value: z.number() }),
  z.object({ type: z.literal('boolean'), value: z.boolean() }),
  z.object({ type: z.literal('datetime'), value: z.int().min(-DATE_MS_MAX).max(DATE_MS_MAX) }),
  z.object({ type: z.literal('duration'), value: z.int() }),
]);

export type ScalarValue = z.infer<typeof scalarValueSchema>;

export const listValueSchema = z
  .object({ type: z.literal('list'), of: scalarTypeSchema, items: z.array(scalarValueSchema) })
  .refine((list) => list.items.every((item) => item.type === list.of), {
    message: 'every item in a list must be the type the list declares',
  });

export type ListValue = z.infer<typeof listValueSchema>;

export const ABSENT_STATES = [
  'unknown_key',
  'unavailable',
  'not_set',
  'restricted',
  'failed',
] as const;

export const absentValueSchema = z.object({
  type: z.literal('absent'),
  state: z.enum(ABSENT_STATES),
  reason: z.string().max(300).optional(),
});

export type AbsentValue = z.infer<typeof absentValueSchema>;

export type AbsentState = AbsentValue['state'];

export const placeholderValueSchema = z.union([scalarValueSchema, listValueSchema]);

export type PlaceholderValue = z.infer<typeof placeholderValueSchema>;

export const resolvedValueSchema = z.union([scalarValueSchema, listValueSchema, absentValueSchema]);

export type ResolvedValue = z.infer<typeof resolvedValueSchema>;

export function typeOf(value: PlaceholderValue): PlaceholderType {
  return value.type === 'list' ? `list<${value.of}>` : value.type;
}

export function elementTypeOf(type: FlowType): ScalarType | undefined {
  return SCALAR_TYPES.find((scalar) => type === `list<${scalar}>`);
}

const TYPE_DESCRIPTIONS: Record<ScalarType | 'formatted', string> = {
  text: 'text',
  markdown: 'formatted text',
  mention: 'a mention',
  url: 'a link',
  image_url: 'an image link',
  integer: 'a whole number',
  number: 'a number',
  percent: 'a percentage',
  boolean: 'a yes-or-no value',
  datetime: 'a date',
  duration: 'a duration',
  formatted: 'already-formatted text',
};

export function describeType(type: FlowType): string {
  if (elementTypeOf(type) !== undefined) return 'a list';

  return TYPE_DESCRIPTIONS[SCALAR_TYPES.find((scalar) => scalar === type) ?? 'formatted'];
}

const URL_FIELD_TYPES: ReadonlySet<FlowType> = new Set<FlowType>([
  'url',
  'image_url',
  'text',
  'integer',
  'number',
]);

export function fieldAccepts(field: TemplateField, type: FlowType): boolean {
  return field !== 'url' || URL_FIELD_TYPES.has(type);
}

export type ReadValue =
  | { ok: true; resolved: ResolvedValue; total: number }
  | { ok: false; problem: string | undefined };

function boundedScalar(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || !('value' in input)) return input;

  const { value } = input;

  return typeof value === 'string' && value.length > PLACEHOLDER_LIMITS.outputLength
    ? { ...input, value: value.slice(0, PLACEHOLDER_LIMITS.outputLength) }
    : input;
}

function listProblem(of: unknown, items: readonly unknown[]): string | undefined {
  const element = scalarTypeSchema.safeParse(of);
  if (!element.success) return undefined;

  const index = items.findIndex((item) => {
    const parsed = scalarValueSchema.safeParse(item);
    return !parsed.success || parsed.data.type !== element.data;
  });

  return index === -1
    ? undefined
    : `is a list whose item ${index + 1} is not ${describeType(element.data)}`;
}

export function readResolved(input: unknown): ReadValue {
  if (
    typeof input === 'object' &&
    input !== null &&
    'items' in input &&
    Array.isArray(input.items)
  ) {
    const items: readonly unknown[] = input.items;
    const max = PLACEHOLDER_LIMITS.listLength;

    if (items.length > max) {
      return {
        ok: false,
        problem: `is a list of ${items.length} items, and a list holds at most ${max}`,
      };
    }

    const parsed = resolvedValueSchema.safeParse({ ...input, items: items.map(boundedScalar) });

    if (!parsed.success) {
      return { ok: false, problem: 'of' in input ? listProblem(input.of, items) : undefined };
    }

    const resolved = parsed.data;
    if (resolved.type !== 'list') return { ok: true, resolved, total: 0 };

    return {
      ok: true,
      resolved: { ...resolved, items: resolved.items.slice(0, PLACEHOLDER_LIMITS.listItems) },
      total: items.length,
    };
  }

  const parsed = resolvedValueSchema.safeParse(boundedScalar(input));
  return parsed.success
    ? { ok: true, resolved: parsed.data, total: 0 }
    : { ok: false, problem: undefined };
}

type ScalarOf<T extends ScalarType> = Extract<ScalarValue, { type: T }>;

function absent(state: AbsentState, reason: string | undefined): AbsentValue {
  return reason === undefined ? { type: 'absent', state } : { type: 'absent', state, reason };
}

function mention(value: string, name: string | undefined): ScalarOf<'mention'> {
  return name === undefined ? { type: 'mention', value } : { type: 'mention', value, name };
}

export const placeholderValue = {
  text: (value: string): ScalarOf<'text'> => ({ type: 'text', value }),
  markdown: (value: string): ScalarOf<'markdown'> => ({ type: 'markdown', value }),
  mention: (markup: string, name?: string): ScalarOf<'mention'> => mention(markup, name),
  user: (id: string, name?: string): ScalarOf<'mention'> => mention(`<@${id}>`, name),
  role: (id: string, name?: string): ScalarOf<'mention'> => mention(`<@&${id}>`, name),
  channel: (id: string, name?: string): ScalarOf<'mention'> => mention(`<#${id}>`, name),
  url: (value: string): ScalarOf<'url'> => ({ type: 'url', value }),
  imageUrl: (value: string): ScalarOf<'image_url'> => ({ type: 'image_url', value }),
  integer: (value: number): ScalarOf<'integer'> => ({ type: 'integer', value }),
  number: (value: number): ScalarOf<'number'> => ({ type: 'number', value }),
  percent: (value: number): ScalarOf<'percent'> => ({ type: 'percent', value }),
  boolean: (value: boolean): ScalarOf<'boolean'> => ({ type: 'boolean', value }),
  datetime: (at: number | Date): ScalarOf<'datetime'> => ({
    type: 'datetime',
    value: at instanceof Date ? at.getTime() : at,
  }),
  duration: (ms: number): ScalarOf<'duration'> => ({ type: 'duration', value: ms }),
  list: <T extends ScalarType>(of: T, items: readonly ScalarOf<T>[]): ListValue => ({
    type: 'list',
    of,
    items: [...items],
  }),
  unknownKey: (reason?: string): AbsentValue => absent('unknown_key', reason),
  unavailable: (reason?: string): AbsentValue => absent('unavailable', reason),
  notSet: (reason?: string): AbsentValue => absent('not_set', reason),
  restricted: (reason?: string): AbsentValue => absent('restricted', reason),
  failed: (reason?: string): AbsentValue => absent('failed', reason),
};
