import { z } from 'zod';
import {
  FIELD_LABELS,
  PLACEHOLDER_LIMITS,
  SENSITIVITIES,
  type Sensitivity,
  sensitivityRank,
  TEMPLATE_FIELDS,
  type TemplateField,
} from './limits.ts';
import { MODIFIER_NAMES } from './modifiers.ts';
import { fieldAccepts, placeholderTypeSchema, placeholderValueSchema, typeOf } from './values.ts';

const SEGMENT = '[a-z][a-z0-9_]*';

const KEY_PATTERN = new RegExp(`^${SEGMENT}(?:\\.(?:${SEGMENT}|<${SEGMENT}>))*$`);

const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

const EVENT_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/;

const DYNAMIC_VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export function isForbiddenKey(key: string): boolean {
  return key.split('.').some((segment) => {
    const name = segment.startsWith('<') && segment.endsWith('>') ? segment.slice(1, -1) : segment;
    return name.startsWith('_') || name === 'constructor' || name === 'prototype';
  });
}

function paramsOf(key: string): string[] {
  return key
    .split('.')
    .filter((segment) => segment.startsWith('<'))
    .map((segment) => segment.slice(1, -1));
}

export const placeholderDefinitionSchema = z
  .object({
    key: z
      .string()
      .max(PLACEHOLDER_LIMITS.keyLength)
      .regex(
        KEY_PATTERN,
        'must be dotted lowercase snake_case segments, with <name> for a dynamic one',
      ),
    aliases: z
      .array(
        z
          .string()
          .max(PLACEHOLDER_LIMITS.keyLength)
          .regex(ALIAS_PATTERN, 'must be dotted segments of letters, digits and underscores'),
      )
      .max(8)
      .default([]),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).default(''),
    group: z.string().trim().min(1).max(40),
    type: placeholderTypeSchema,
    example: placeholderValueSchema,
    availability: z
      .object({
        events: z.array(z.string().max(100).regex(EVENT_PATTERN)).min(1).optional(),
        fields: z.array(z.enum(TEMPLATE_FIELDS)).min(1).optional(),
      })
      .default({}),
    sensitivity: z.enum(SENSITIVITIES).default('public'),
    modifiers: z.array(z.enum(MODIFIER_NAMES)).optional(),
  })
  .superRefine((definition, ctx) => {
    for (const name of [definition.key, ...definition.aliases]) {
      if (!isForbiddenKey(name)) continue;

      ctx.addIssue({
        code: 'custom',
        path: ['key'],
        message: `'${name}' uses a reserved segment: nothing may start with an underscore or be constructor or prototype`,
      });
    }

    const params = paramsOf(definition.key);

    if (params.length > 0 && definition.aliases.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['aliases'],
        message: 'a key with a dynamic segment cannot have aliases',
      });
    }

    if (new Set(params).size !== params.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['key'],
        message: 'two dynamic segments share a name, so one would overwrite the other',
      });
    }

    if (typeOf(definition.example) !== definition.type) {
      ctx.addIssue({
        code: 'custom',
        path: ['example'],
        message: `the example is ${typeOf(definition.example)} but the placeholder is ${definition.type}`,
      });
    }
  });

export type PlaceholderDefinitionInput = z.input<typeof placeholderDefinitionSchema>;

export type PlaceholderDefinition = z.output<typeof placeholderDefinitionSchema>;

export class PlaceholderDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaceholderDefinitionError';
  }
}

export interface PlaceholderResolution {
  definition: PlaceholderDefinition;
  key: string;
  canonical: string;
  alias: boolean;
  params: Readonly<Record<string, string>>;
}

export interface PlaceholderRegistry {
  readonly definitions: readonly PlaceholderDefinition[];
  resolve(key: string): PlaceholderResolution | undefined;
}

type Segment = { literal: string } | { param: string };

interface Pattern {
  definition: PlaceholderDefinition;
  segments: readonly Segment[];
}

const NO_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

function matchPattern(
  segments: readonly Segment[],
  parts: readonly string[],
): Readonly<Record<string, string>> | undefined {
  if (segments.length !== parts.length) return undefined;

  const params: Array<[string, string]> = [];

  for (const [index, segment] of segments.entries()) {
    const part = parts[index] ?? '';

    if ('literal' in segment) {
      if (segment.literal !== part) return undefined;
      continue;
    }

    if (!DYNAMIC_VALUE.test(part)) return undefined;
    params.push([segment.param, part]);
  }

  return Object.fromEntries(params);
}

export function createPlaceholderRegistry(
  inputs: readonly PlaceholderDefinitionInput[],
): PlaceholderRegistry {
  const definitions: PlaceholderDefinition[] = [];
  const exact = new Map<string, { definition: PlaceholderDefinition; alias: boolean }>();
  const patterns: Pattern[] = [];
  const shapes = new Map<string, string>();

  for (const [index, input] of inputs.entries()) {
    const parsed = placeholderDefinitionSchema.safeParse(input);

    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || 'definition'}: ${issue.message}`)
        .join('; ');
      throw new PlaceholderDefinitionError(
        `placeholder definition #${index + 1} is invalid — ${detail}`,
      );
    }

    const definition = parsed.data;
    definitions.push(definition);

    if (paramsOf(definition.key).length > 0) {
      const segments = definition.key
        .split('.')
        .map(
          (segment): Segment =>
            segment.startsWith('<') ? { param: segment.slice(1, -1) } : { literal: segment },
        );
      const shape = segments
        .map((segment) => ('literal' in segment ? segment.literal : '<>'))
        .join('.');
      const taken = shapes.get(shape);

      if (taken !== undefined) {
        throw new PlaceholderDefinitionError(
          `{${definition.key}} and {${taken}} match exactly the same keys, so neither could be told apart`,
        );
      }

      shapes.set(shape, definition.key);
      patterns.push({ definition, segments });
      continue;
    }

    const names: Array<readonly [string, boolean]> = [
      [definition.key, false],
      ...definition.aliases.map((alias) => [alias, true] as const),
    ];

    for (const [name, alias] of names) {
      const claimed = exact.get(name);

      if (claimed !== undefined) {
        throw new PlaceholderDefinitionError(
          `{${name}} is claimed by both {${claimed.definition.key}} and {${definition.key}}`,
        );
      }

      exact.set(name, { definition, alias });
    }
  }

  return {
    definitions,
    resolve(key) {
      if (key.length > PLACEHOLDER_LIMITS.keyLength || isForbiddenKey(key)) return undefined;

      const hit = exact.get(key);
      if (hit !== undefined) {
        return {
          definition: hit.definition,
          key,
          canonical: hit.definition.key,
          alias: hit.alias,
          params: NO_PARAMS,
        };
      }

      const parts = key.split('.');

      for (const pattern of patterns) {
        const params = matchPattern(pattern.segments, parts);
        if (params !== undefined) {
          return { definition: pattern.definition, key, canonical: key, alias: false, params };
        }
      }

      return undefined;
    },
  };
}

export interface PlaceholderContext {
  field: TemplateField;
  event?: string | undefined;
  audience?: Sensitivity | undefined;
}

export function unavailableReason(
  definition: PlaceholderDefinition,
  context: PlaceholderContext,
): string | undefined {
  const { events, fields } = definition.availability;

  if (fields !== undefined && !fields.includes(context.field)) {
    return `cannot be used in ${FIELD_LABELS[context.field]}`;
  }

  if (events !== undefined && (context.event === undefined || !events.includes(context.event))) {
    return context.event === undefined
      ? `is only available for ${events.join(', ')}`
      : `is not available for ${context.event}`;
  }

  return undefined;
}

export function isRestricted(
  definition: PlaceholderDefinition,
  audience: Sensitivity = 'public',
): boolean {
  return sensitivityRank(definition.sensitivity) > sensitivityRank(audience);
}

export function definitionsFor(
  registry: PlaceholderRegistry,
  context: PlaceholderContext,
): PlaceholderDefinition[] {
  return registry.definitions.filter(
    (definition) =>
      unavailableReason(definition, context) === undefined &&
      !isRestricted(definition, context.audience) &&
      fieldAccepts(context.field, definition.type),
  );
}
