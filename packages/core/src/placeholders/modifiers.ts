import type { DiagnosticReporter, Span } from './diagnostics.ts';
import {
  compactNumber,
  type FormatEnv,
  formatDateTime,
  formatRelative,
  groupedNumber,
  ordinalNumber,
  percentText,
  readableDuration,
  slugify,
  truncateText,
  unixSeconds,
} from './format.ts';
import { FIELD_LABELS, PLACEHOLDER_LIMITS, type TemplateField } from './limits.ts';
import {
  describeType,
  elementTypeOf,
  type FlowType,
  fieldAccepts,
  type PlaceholderType,
  type PlaceholderValue,
  type ScalarValue,
} from './values.ts';

export const MODIFIER_NAMES = [
  'number',
  'compact',
  'ordinal',
  'percent',
  'upper',
  'lower',
  'truncate',
  'slug',
  'relative',
  'full',
  'date',
  'time',
  'unix',
  'duration',
  'fallback',
  'join',
  'limit',
  'count',
  'label',
] as const;

export type ModifierName = (typeof MODIFIER_NAMES)[number];

export type ModifierArgument = number | string;

export interface ParsedModifier {
  name: string;
  args: readonly ModifierArgument[];
  span: Span;
}

type ArgumentKind = 'integer' | 'string';

interface ModifierSpec {
  args: readonly ArgumentKind[];
  range?: readonly [number, number];
  usage: string;
  description: string;
  prose?: true;
  accepts(type: FlowType): boolean;
  result(type: FlowType): FlowType;
}

function oneOf(...types: FlowType[]): (type: FlowType) => boolean {
  return (type) => types.includes(type);
}

function isList(type: FlowType): boolean {
  return elementTypeOf(type) !== undefined;
}

function keep(type: FlowType): FlowType {
  return type;
}

function becomes(next: FlowType): () => FlowType {
  return () => next;
}

const numeric = oneOf('integer', 'number', 'percent');
const textual = oneOf('text', 'markdown');
const dated = oneOf('datetime');

const MODIFIERS: Record<ModifierName, ModifierSpec> = {
  number: {
    args: [],
    usage: ':number',
    description: 'Groups the digits, like 1,204.',
    prose: true,
    accepts: numeric,
    result: becomes('formatted'),
  },
  compact: {
    args: [],
    usage: ':compact',
    description: 'Shortens big numbers, like 1.2K.',
    prose: true,
    accepts: oneOf('integer', 'number'),
    result: becomes('formatted'),
  },
  ordinal: {
    args: [],
    usage: ':ordinal',
    description: 'Adds st, nd, rd or th, like 3rd.',
    prose: true,
    accepts: oneOf('integer'),
    result: becomes('formatted'),
  },
  percent: {
    args: [],
    usage: ':percent',
    description: 'Adds a % sign, like 45%.',
    prose: true,
    accepts: numeric,
    result: becomes('formatted'),
  },
  upper: {
    args: [],
    usage: ':upper',
    description: 'All capital letters.',
    accepts: textual,
    result: keep,
  },
  lower: {
    args: [],
    usage: ':lower',
    description: 'All lowercase letters.',
    accepts: textual,
    result: keep,
  },
  truncate: {
    args: ['integer'],
    range: [1, PLACEHOLDER_LIMITS.outputLength],
    usage: ':truncate(40)',
    description: 'Cuts it to a number of characters and adds … when it was longer.',
    accepts: textual,
    result: keep,
  },
  slug: {
    args: [],
    usage: ':slug',
    description: 'Lowercase with dashes, like proton-hq.',
    accepts: oneOf('text'),
    result: keep,
  },
  relative: {
    args: [],
    usage: ':relative',
    description: 'How long ago or from now, like 3 hours ago.',
    prose: true,
    accepts: dated,
    result: becomes('formatted'),
  },
  full: {
    args: [],
    usage: ':full',
    description: 'The full date and time, with the day of the week.',
    prose: true,
    accepts: dated,
    result: becomes('formatted'),
  },
  date: {
    args: [],
    usage: ':date',
    description: 'Just the date.',
    prose: true,
    accepts: dated,
    result: becomes('formatted'),
  },
  time: {
    args: [],
    usage: ':time',
    description: 'Just the time.',
    prose: true,
    accepts: dated,
    result: becomes('formatted'),
  },
  unix: {
    args: [],
    usage: ':unix',
    description: 'A Unix timestamp in seconds.',
    accepts: dated,
    result: becomes('integer'),
  },
  duration: {
    args: [],
    usage: ':duration',
    description: 'A readable length of time, like 3 days.',
    prose: true,
    accepts: oneOf('duration'),
    result: becomes('formatted'),
  },
  fallback: {
    args: ['string'],
    usage: ':fallback("nobody")',
    description: 'What to show when there’s no value.',
    accepts: () => true,
    result: keep,
  },
  join: {
    args: ['string'],
    usage: ':join(", ")',
    description: 'Joins the list with your own separator.',
    prose: true,
    accepts: isList,
    result: becomes('formatted'),
  },
  limit: {
    args: ['integer'],
    range: [1, PLACEHOLDER_LIMITS.listItems],
    usage: ':limit(5)',
    description: 'Keeps only the first few items of the list.',
    accepts: isList,
    result: keep,
  },
  count: {
    args: [],
    usage: ':count',
    description: 'How many items the list has.',
    accepts: isList,
    result: becomes('integer'),
  },
  label: {
    args: ['string', 'string'],
    usage: ':label("yes","no")',
    description: 'Your own words for yes and no.',
    prose: true,
    accepts: oneOf('boolean'),
    result: becomes('formatted'),
  },
};

export function modifierUsage(name: ModifierName): string {
  return MODIFIERS[name].usage;
}

export function modifierDescription(name: ModifierName): string {
  return MODIFIERS[name].description;
}

export function modifiersFor(type: FlowType, field: TemplateField): ModifierName[] {
  return MODIFIER_NAMES.filter(
    (name) => MODIFIERS[name].accepts(type) && !(MODIFIERS[name].prose && field === 'url'),
  );
}

export interface ModifierChoice {
  name: ModifierName;
  usage: string;
  description: string;
  takesArguments: boolean;
}

export interface ModifierChoiceContext {
  type: PlaceholderType;
  field: TemplateField;
  allowed?: readonly ModifierName[] | undefined;
  previous: readonly string[];
}

function knownModifier(name: string): ModifierName | undefined {
  return MODIFIER_NAMES.find((known) => known === name);
}

function offers(
  name: ModifierName,
  type: FlowType,
  field: TemplateField,
  allowed: readonly ModifierName[] | undefined,
): boolean {
  const spec = MODIFIERS[name];
  if (name !== 'fallback' && allowed !== undefined && !allowed.includes(name)) return false;
  if (spec.prose && field === 'url') return false;
  return spec.accepts(type);
}

export function modifierChoices({
  type,
  field,
  allowed,
  previous,
}: ModifierChoiceContext): ModifierChoice[] {
  let flow: FlowType = type;
  const used = new Set<ModifierName>();

  for (const raw of previous) {
    const name = knownModifier(raw);
    if (name === undefined) continue;

    used.add(name);
    if (name !== 'fallback' && offers(name, flow, field, allowed))
      flow = MODIFIERS[name].result(flow);
  }

  return MODIFIER_NAMES.filter((name) => !used.has(name) && offers(name, flow, field, allowed)).map(
    (name) => ({
      name,
      usage: MODIFIERS[name].usage,
      description: MODIFIERS[name].description,
      takesArguments: MODIFIERS[name].args.length > 0,
    }),
  );
}

function closestModifier(name: string): ModifierName | undefined {
  const lower = name.toLowerCase();
  let best: ModifierName | undefined;
  let distance = 3;

  for (const known of MODIFIER_NAMES) {
    if (known === lower) return known;
    if (Math.abs(known.length - lower.length) >= distance) continue;

    let previous = Array.from({ length: lower.length + 1 }, (_, index) => index);
    for (let row = 1; row <= known.length; row += 1) {
      const current = [row];
      for (let column = 1; column <= lower.length; column += 1) {
        const cost = known.charAt(row - 1) === lower.charAt(column - 1) ? 0 : 1;
        current.push(
          Math.min(
            (previous[column] ?? distance) + 1,
            (current[column - 1] ?? distance) + 1,
            (previous[column - 1] ?? distance) + cost,
          ),
        );
      }
      previous = current;
    }

    const found = previous[lower.length] ?? distance;
    if (found < distance) {
      best = known;
      distance = found;
    }
  }

  return best;
}

function argumentProblem(
  spec: ModifierSpec,
  args: readonly ModifierArgument[],
): string | undefined {
  if (args.length !== spec.args.length) {
    if (spec.args.length === 0) return 'takes no arguments';
    return spec.args.length === 1 ? 'takes one argument' : `takes ${spec.args.length} arguments`;
  }

  for (const [index, kind] of spec.args.entries()) {
    const arg = args[index];

    if (kind === 'string' && typeof arg !== 'string') return 'takes quoted text';

    if (kind === 'integer') {
      const [min, max] = spec.range ?? [0, Number.MAX_SAFE_INTEGER];
      if (typeof arg !== 'number' || !Number.isInteger(arg) || arg < min || arg > max) {
        return `takes a whole number from ${min} to ${max}`;
      }
    }
  }

  return undefined;
}

export interface ModifierStep {
  name: Exclude<ModifierName, 'fallback'>;
  args: readonly ModifierArgument[];
}

export interface ModifierPlan {
  steps: readonly ModifierStep[];
  fallback: string | undefined;
  type: FlowType;
  fits: boolean;
}

export interface ModifierSubject {
  raw: string;
  span: Span;
  type: PlaceholderType;
  allowed: readonly ModifierName[] | undefined;
}

export function planModifiers(
  modifiers: readonly ParsedModifier[],
  subject: ModifierSubject,
  field: TemplateField,
  reporter: DiagnosticReporter,
): ModifierPlan {
  const steps: ModifierStep[] = [];
  let fallback: string | undefined;
  let type: FlowType = subject.type;

  for (const modifier of modifiers) {
    const name = MODIFIER_NAMES.find((known) => known === modifier.name);

    if (name === undefined) {
      const guess = closestModifier(modifier.name);
      reporter.report(
        'unknown_modifier',
        `:${modifier.name} isn't a modifier, so ${subject.raw} ignores it.` +
          (guess === undefined ? '' : ` Did you mean :${guess}?`),
        modifier.span,
      );
      continue;
    }

    const spec = MODIFIERS[name];
    const problem = argumentProblem(spec, modifier.args);

    if (problem !== undefined) {
      reporter.report(
        'invalid_argument',
        `in ${subject.raw}, :${name} ${problem}, as in ${spec.usage}.`,
        modifier.span,
      );
      continue;
    }

    if (name !== 'fallback' && subject.allowed !== undefined && !subject.allowed.includes(name)) {
      reporter.report(
        'incompatible_modifier',
        `${subject.raw} doesn't take :${name}, so it's ignored.`,
        modifier.span,
      );
      continue;
    }

    if (spec.prose && field === 'url') {
      reporter.report(
        'incompatible_modifier',
        `:${name} writes readable text, which can't go in ${FIELD_LABELS.url}, so ${subject.raw} ignores it.`,
        modifier.span,
      );
      continue;
    }

    if (!spec.accepts(type)) {
      reporter.report(
        'incompatible_modifier',
        `:${name} doesn't work on ${describeType(type)}, so ${subject.raw} ignores it.`,
        modifier.span,
      );
      continue;
    }

    if (name === 'fallback') {
      if (fallback !== undefined) {
        reporter.report(
          'incompatible_modifier',
          `${subject.raw} has more than one :fallback; only the first is used.`,
          modifier.span,
        );
        continue;
      }

      const [text] = modifier.args;
      fallback = typeof text === 'string' ? text : undefined;
      continue;
    }

    steps.push({ name, args: modifier.args });
    type = spec.result(type);
  }

  const fits = fieldAccepts(field, type);

  if (!fits) {
    reporter.report(
      'incompatible_field',
      `${subject.raw} is ${describeType(type)}, which can't go in ${FIELD_LABELS[field]}.`,
      subject.span,
    );
  }

  return { steps, fallback, type, fits };
}

export type Flow =
  | { kind: 'value'; value: PlaceholderValue; total: number }
  | { kind: 'formatted'; text: string; authored: boolean };

export interface StepEnv extends FormatEnv {
  field: TemplateField;
  renderItem(item: ScalarValue): string;
}

function formatted(text: string, authored = false): Flow {
  return { kind: 'formatted', text, authored };
}

function integerArgument(step: ModifierStep, index: number): number {
  const arg = step.args[index];
  return typeof arg === 'number' ? arg : 0;
}

function textArgument(step: ModifierStep, index: number): string {
  const arg = step.args[index];
  return typeof arg === 'string' ? arg : '';
}

function withNumber(flow: Flow, format: (value: number) => string): Flow {
  if (flow.kind !== 'value') return flow;

  const { value } = flow;
  return value.type === 'integer' || value.type === 'number' || value.type === 'percent'
    ? formatted(format(value.value))
    : flow;
}

function withText(flow: Flow, change: (text: string) => string): Flow {
  if (flow.kind !== 'value') return flow;

  const { value } = flow;
  if (value.type !== 'text' && value.type !== 'markdown') return flow;

  return { kind: 'value', value: { type: value.type, value: change(value.value) }, total: 0 };
}

function withDate(flow: Flow, format: (ms: number) => string): Flow {
  if (flow.kind !== 'value' || flow.value.type !== 'datetime') return flow;
  return formatted(format(flow.value.value));
}

export function applyStep(flow: Flow, step: ModifierStep, env: StepEnv): Flow {
  const discord = env.field === 'discord_text';

  switch (step.name) {
    case 'number':
      return withNumber(flow, (value) => groupedNumber(value, env.locale));
    case 'compact':
      return withNumber(flow, (value) => compactNumber(value, env.locale));
    case 'ordinal':
      return withNumber(flow, ordinalNumber);
    case 'percent':
      return withNumber(flow, (value) => percentText(value, env.locale, true));
    case 'upper':
      return withText(flow, (text) => text.toLocaleUpperCase(env.locale));
    case 'lower':
      return withText(flow, (text) => text.toLocaleLowerCase(env.locale));
    case 'truncate':
      return withText(flow, (text) => truncateText(text, integerArgument(step, 0)));
    case 'slug':
      return withText(flow, slugify);
    case 'relative':
      return withDate(flow, (ms) => formatRelative(ms, discord, env));
    case 'full':
      return withDate(flow, (ms) => formatDateTime(ms, 'full', discord, env));
    case 'date':
      return withDate(flow, (ms) => formatDateTime(ms, 'date', discord, env));
    case 'time':
      return withDate(flow, (ms) => formatDateTime(ms, 'time', discord, env));
    case 'unix':
      if (flow.kind !== 'value' || flow.value.type !== 'datetime') return flow;
      return {
        kind: 'value',
        value: { type: 'integer', value: unixSeconds(flow.value.value) },
        total: 0,
      };
    case 'duration':
      if (flow.kind !== 'value' || flow.value.type !== 'duration') return flow;
      return formatted(readableDuration(flow.value.value));
    case 'join':
      if (flow.kind !== 'value' || flow.value.type !== 'list') return flow;
      return formatted(flow.value.items.map(env.renderItem).join(textArgument(step, 0)));
    case 'limit': {
      if (flow.kind !== 'value' || flow.value.type !== 'list') return flow;
      const limit = integerArgument(step, 0);
      return {
        kind: 'value',
        value: { ...flow.value, items: flow.value.items.slice(0, limit) },
        total: Math.min(flow.total, limit),
      };
    }
    case 'count':
      if (flow.kind !== 'value' || flow.value.type !== 'list') return flow;
      return { kind: 'value', value: { type: 'integer', value: flow.total }, total: 0 };
    case 'label':
      if (flow.kind !== 'value' || flow.value.type !== 'boolean') return flow;
      return formatted(textArgument(step, flow.value.value ? 0 : 1), true);
  }
}
