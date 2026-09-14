import { z } from 'zod';
import {
  createPlaceholderRegistry,
  definitionsFor,
  isRestricted,
  type PlaceholderDefinition,
  PlaceholderDefinitionError,
  type PlaceholderDefinitionInput,
  type PlaceholderRegistry,
  unavailableReason,
} from './definitions.ts';
import {
  DIAGNOSTIC_CODES,
  type DiagnosticSeverity,
  templateDiagnosticSchema,
} from './diagnostics.ts';
import { parseTemplate } from './grammar.ts';
import {
  CHANNEL_KINDS,
  type ChannelKind,
  SENSITIVITIES,
  type Sensitivity,
  TEMPLATE_FIELDS,
  type TemplateField,
} from './limits.ts';
import type { PlaceholderLookup } from './render.ts';
import type { SampleId } from './samples.ts';
import type { ResolvedValue } from './values.ts';

export interface TemplateFieldSpec {
  path: string;
  kind: TemplateField;
  channel?: ChannelKind | undefined;
  label: string;
  limit?: number | undefined;
  finish?: ((rendered: string) => string) | undefined;
}

export type PingKind = 'roles' | 'users';

export interface SurfaceSample<F> {
  id: SampleId;
  label: string;
  facts: F;
}

export interface BuildEnv {
  now: number;
  keys?: ReadonlySet<string> | undefined;
}

export interface PlaceholderSurfaceInput<F> {
  id: string;
  module: string;
  label: string;
  event: string;
  audience: Sensitivity;
  fields: readonly TemplateFieldSpec[];
  definitions: readonly PlaceholderDefinitionInput[];
  build(facts: F, env: BuildEnv): PlaceholderLookup;
  samples: readonly SurfaceSample<F>[];
  pings?: Readonly<Record<string, PingKind>> | undefined;
}

export interface PlaceholderSurface<F> {
  readonly id: string;
  readonly module: string;
  readonly label: string;
  readonly event: string;
  readonly audience: Sensitivity;
  readonly fields: readonly TemplateFieldSpec[];
  build(facts: F, env: BuildEnv): PlaceholderLookup;
  readonly samples: readonly SurfaceSample<F>[];
  readonly pings: Readonly<Record<string, PingKind>>;
  readonly registry: PlaceholderRegistry;
  readonly definitions: readonly PlaceholderDefinition[];
  fieldAt(path: string): TemplateFieldSpec | undefined;
  pickerFor(path: string): PlaceholderDefinition[];
}

export const SURFACE_DIAGNOSTIC_CODES = [
  'may_ping',
  'doubled_brace_literal',
  'legacy_alias',
  'legacy_alias_in_url',
  'plain_text_value',
] as const;

export type SurfaceDiagnosticCode = (typeof SURFACE_DIAGNOSTIC_CODES)[number];

export const SURFACE_DIAGNOSTIC_SEVERITY: Record<SurfaceDiagnosticCode, DiagnosticSeverity> = {
  may_ping: 'warning',
  doubled_brace_literal: 'warning',
  legacy_alias: 'info',
  legacy_alias_in_url: 'info',
  plain_text_value: 'info',
};

export const surfaceDiagnosticSchema = templateDiagnosticSchema.extend({
  code: z.enum([...DIAGNOSTIC_CODES, ...SURFACE_DIAGNOSTIC_CODES]),
});

export type SurfaceDiagnostic = z.infer<typeof surfaceDiagnosticSchema>;

const SURFACE_ID = /^[a-z0-9][a-z0-9_.:-]*$/;

const MODULE_ID = /^[a-z0-9][a-z0-9_-]*$/;

const PATH_SEGMENT = /^(?:\*|[A-Za-z0-9_]+)$/;

const INDEX = /^\d+$/;

const MENTION_TYPES: ReadonlySet<string> = new Set(['mention', 'list<mention>']);

function fieldProblems(fields: readonly TemplateFieldSpec[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const spec of fields) {
    const where = `field '${spec.path}'`;

    if (spec.path.split('.').some((segment) => !PATH_SEGMENT.test(segment))) {
      problems.push(
        `${where} must be dotted segments of letters, digits and underscores, with * for an array index`,
      );
    }
    if (seen.has(spec.path)) problems.push(`${where} is declared twice`);
    seen.add(spec.path);

    if (!TEMPLATE_FIELDS.includes(spec.kind)) problems.push(`${where} has an unknown kind`);
    if (spec.kind === 'channel_name') {
      if (spec.channel === undefined || !CHANNEL_KINDS.includes(spec.channel)) {
        problems.push(`${where} is a channel name, so it needs channel 'text' or 'voice'`);
      }
    } else if (spec.channel !== undefined) {
      problems.push(`${where} sets a channel, which only a channel name field reads`);
    }

    if (spec.limit !== undefined && (!Number.isInteger(spec.limit) || spec.limit < 1)) {
      problems.push(`${where} needs a limit that is a whole number of at least 1`);
    }
    if (spec.label.trim() === '') problems.push(`${where} has no label`);
  }

  return problems;
}

function surfaceProblems<F>(input: PlaceholderSurfaceInput<F>): string[] {
  const problems: string[] = [];

  if (!SURFACE_ID.test(input.id)) {
    problems.push('its id must be lowercase letters, digits and . _ : -');
  }
  if (!MODULE_ID.test(input.module)) {
    problems.push(`module '${input.module}' must be lowercase letters, digits, _ and -`);
  }
  if (!SURFACE_ID.test(input.event)) {
    problems.push(`event '${input.event}' must be lowercase letters, digits and . _ : -`);
  }
  if (input.label.trim() === '') problems.push('it has no label');
  if (!SENSITIVITIES.includes(input.audience)) problems.push('its audience is not a sensitivity');

  problems.push(...fieldProblems(input.fields));

  const samples = new Set<string>();
  for (const sample of input.samples) {
    if (samples.has(sample.id)) problems.push(`sample '${sample.id}' is declared twice`);
    samples.add(sample.id);
  }

  return problems;
}

function pingProblems(
  pings: Readonly<Record<string, PingKind>>,
  registry: PlaceholderRegistry,
): string[] {
  const problems: string[] = [];

  for (const [key, kind] of Object.entries(pings)) {
    if (kind !== 'roles' && kind !== 'users') {
      problems.push(`ping '${key}' must be 'roles' or 'users'`);
    }

    const resolution = registry.resolve(key);
    if (resolution?.canonical === key && !MENTION_TYPES.has(resolution.definition.type)) {
      problems.push(`ping '${key}' is ${resolution.definition.type}, which never writes a mention`);
    }
  }

  return problems;
}

function invalid(id: string, detail: string): PlaceholderDefinitionError {
  return new PlaceholderDefinitionError(`placeholder surface '${id}' is invalid — ${detail}`);
}

function registryFor(id: string, definitions: readonly PlaceholderDefinitionInput[]) {
  try {
    return createPlaceholderRegistry(definitions);
  } catch (error) {
    if (error instanceof PlaceholderDefinitionError) throw invalid(id, error.message);
    throw error;
  }
}

function matchesPath(pattern: readonly string[], parts: readonly string[]): boolean {
  return (
    pattern.length === parts.length &&
    pattern.every((segment, index) => {
      const part = parts[index] ?? '';
      return segment === '*' ? INDEX.test(part) : segment === part;
    })
  );
}

export function definePlaceholderSurface<F>(
  input: PlaceholderSurfaceInput<F>,
): PlaceholderSurface<F> {
  const problems = surfaceProblems(input);
  if (problems.length > 0) throw invalid(input.id, problems.join('; '));

  const registry = registryFor(input.id, input.definitions);
  const pings = Object.freeze({ ...(input.pings ?? {}) });

  const pinged = pingProblems(pings, registry);
  if (pinged.length > 0) throw invalid(input.id, pinged.join('; '));

  const patterns = input.fields.map((spec) => ({ spec, segments: spec.path.split('.') }));

  const fieldAt = (path: string): TemplateFieldSpec | undefined => {
    const parts = path.split('.');
    return patterns.find(({ segments }) => matchesPath(segments, parts))?.spec;
  };

  return Object.freeze({
    id: input.id,
    module: input.module,
    label: input.label,
    event: input.event,
    audience: input.audience,
    fields: input.fields,
    build: (facts: F, env: BuildEnv) => input.build(facts, env),
    samples: input.samples,
    pings,
    registry,
    definitions: registry.definitions,
    fieldAt,
    pickerFor: (path: string) => {
      const spec = fieldAt(path);
      if (spec === undefined) return [];
      return definitionsFor(registry, {
        field: spec.kind,
        event: input.event,
        audience: input.audience,
      });
    },
  });
}

function isAbsent(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'absent';
}

export function aliasFallbacks(
  lookup: PlaceholderLookup,
  byAlias: Readonly<Record<string, ResolvedValue>>,
): PlaceholderLookup {
  return (request) => {
    const value = lookup(request);
    if (request.key === request.canonical || !Object.hasOwn(byAlias, request.key)) return value;

    return isAbsent(value) ? (byAlias[request.key] ?? value) : value;
  };
}

export function aliasValues(
  lookup: PlaceholderLookup,
  byAlias: Readonly<Record<string, ResolvedValue>>,
): PlaceholderLookup {
  return (request) => {
    if (request.key === request.canonical || !Object.hasOwn(byAlias, request.key)) {
      return lookup(request);
    }

    return byAlias[request.key] ?? lookup(request);
  };
}

type SurfaceRegistry = Pick<PlaceholderSurface<unknown>, 'registry'>;

type SurfaceScope = Pick<PlaceholderSurface<unknown>, 'registry' | 'event' | 'audience' | 'fields'>;

function allowedOn(
  scope: Pick<SurfaceScope, 'event' | 'audience' | 'fields'>,
  definition: PlaceholderDefinition,
): boolean {
  if (isRestricted(definition, scope.audience)) return false;

  return scope.fields.some(
    ({ kind }) => unavailableReason(definition, { field: kind, event: scope.event }) === undefined,
  );
}

export function usedKeys(surface: SurfaceRegistry, templates: Iterable<string>): Set<string>;
export function usedKeys(
  surface: SurfaceScope,
  templates: Iterable<string>,
  options: { allowedOnly: true },
): Set<string>;
export function usedKeys(
  surface: SurfaceRegistry & Partial<SurfaceScope>,
  templates: Iterable<string>,
  options?: { allowedOnly: true },
): Set<string> {
  const { event, audience, fields } = surface;
  const scope =
    options?.allowedOnly === true &&
    event !== undefined &&
    audience !== undefined &&
    fields !== undefined
      ? { event, audience, fields }
      : undefined;
  const keys = new Set<string>();

  for (const template of templates) {
    for (const token of parseTemplate(template, surface.registry).tokens) {
      if (token.kind !== 'placeholder' || token.canonical === null) continue;

      if (scope !== undefined) {
        const resolution = surface.registry.resolve(token.key);
        if (resolution === undefined || !allowedOn(scope, resolution.definition)) continue;
      }

      keys.add(token.canonical);
    }
  }

  return keys;
}

export function mentionsAny(
  surface: SurfaceRegistry,
  value: string,
  keys: readonly string[],
): boolean {
  return parseTemplate(value, surface.registry).tokens.some(
    (token) =>
      token.kind === 'placeholder' && token.canonical !== null && keys.includes(token.canonical),
  );
}

const SUGGESTION_DISTANCE = 2;

function editDistance(from: string, to: string, bound: number): number {
  let previous = Array.from({ length: to.length + 1 }, (_, index) => index);

  for (let row = 1; row <= from.length; row += 1) {
    const current = [row];
    let smallest = row;

    for (let column = 1; column <= to.length; column += 1) {
      const cost = from.charAt(row - 1) === to.charAt(column - 1) ? 0 : 1;
      const value = Math.min(
        (previous[column] ?? bound) + 1,
        (current[column - 1] ?? bound) + 1,
        (previous[column - 1] ?? bound) + cost,
      );
      current.push(value);
      smallest = Math.min(smallest, value);
    }

    if (smallest >= bound) return bound;
    previous = current;
  }

  return previous[to.length] ?? bound;
}

export function suggestKey(registry: PlaceholderRegistry, key: string): string | undefined {
  let best: string | undefined;
  let distance = SUGGESTION_DISTANCE + 1;

  for (const definition of registry.definitions) {
    const names = definition.key.includes('<')
      ? definition.aliases
      : [definition.key, ...definition.aliases];

    for (const name of names) {
      if (Math.abs(name.length - key.length) >= distance) continue;

      const found = editDistance(name, key, distance);
      if (found > 0 && found < distance) {
        best = name;
        distance = found;
      }
    }
  }

  return best;
}
