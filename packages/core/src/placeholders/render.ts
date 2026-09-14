import { type BindContext, bindPlaceholder } from './bind.ts';
import type {
  PlaceholderDefinition,
  PlaceholderRegistry,
  PlaceholderResolution,
} from './definitions.ts';
import {
  createReporter,
  type DiagnosticCode,
  type DiagnosticReporter,
  type TemplateDiagnostic,
} from './diagnostics.ts';
import {
  breakMassMentions,
  clip,
  encodeMassMentions,
  encodeUrlPart,
  escapeDiscordMarkdown,
  type FormatEnv,
  formatDateTime,
  isHttpUrl,
  normaliseChannelName,
  percentText,
  plainInteger,
  plainNumber,
  readableDuration,
} from './format.ts';
import { type ParsedTemplate, type PlaceholderToken, parseTemplate } from './grammar.ts';
import {
  type ChannelKind,
  FIELD_LABELS,
  PLACEHOLDER_LIMITS,
  type Sensitivity,
  type TemplateField,
} from './limits.ts';
import { applyStep, type Flow, type ModifierPlan } from './modifiers.ts';
import {
  type AbsentState,
  type AbsentValue,
  describeType,
  type ReadValue,
  type ResolvedValue,
  readResolved,
  type ScalarValue,
  typeOf,
} from './values.ts';

export interface PlaceholderRequest {
  key: string;
  canonical: string;
  definition: PlaceholderDefinition;
  params: Readonly<Record<string, string>>;
}

export type PlaceholderLookup = (request: PlaceholderRequest) => ResolvedValue;

export interface RenderOptions {
  registry: PlaceholderRegistry;
  field: TemplateField;
  channel?: ChannelKind | undefined;
  event?: string | undefined;
  audience?: Sensitivity | undefined;
  locale?: string | undefined;
  timeZone?: string | undefined;
  now?: number | Date | undefined;
}

export interface RenderResult {
  output: string;
  diagnostics: TemplateDiagnostic[];
  unknown: string[];
}

interface RenderEnv extends FormatEnv {
  field: TemplateField;
}

interface Piece {
  text: string;
  authored: boolean;
}

function authored(text: string): Piece {
  return { text, authored: true };
}

function substituted(text: string): Piece {
  return { text, authored: false };
}

const UNAVAILABLE: ResolvedValue = { type: 'absent', state: 'unavailable' };

function isMap(
  values: ReadonlyMap<string, ResolvedValue> | Readonly<Record<string, ResolvedValue>>,
): values is ReadonlyMap<string, ResolvedValue> {
  return values instanceof Map;
}

export function lookupFrom(
  values: ReadonlyMap<string, ResolvedValue> | Readonly<Record<string, ResolvedValue>>,
): PlaceholderLookup {
  if (isMap(values)) return ({ canonical }) => values.get(canonical) ?? UNAVAILABLE;

  return ({ canonical }) =>
    Object.hasOwn(values, canonical) ? (values[canonical] ?? UNAVAILABLE) : UNAVAILABLE;
}

function canonicalLocale(locale: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

function isTimeZone(timeZone: string): boolean {
  try {
    return Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
}

function environment(options: RenderOptions, reporter: DiagnosticReporter): RenderEnv {
  let locale = 'en-US';
  if (options.locale !== undefined) {
    const canonical = canonicalLocale(options.locale);
    if (canonical === undefined) {
      reporter.report(
        'invalid_locale',
        `'${options.locale}' is not a locale, so dates and numbers are written for en-US.`,
        null,
      );
    } else {
      locale = canonical;
    }
  }

  let timeZone = 'UTC';
  if (options.timeZone !== undefined) {
    if (isTimeZone(options.timeZone)) {
      timeZone = options.timeZone;
    } else {
      reporter.report(
        'invalid_time_zone',
        `'${options.timeZone}' is not a time zone, so times are written in UTC.`,
        null,
      );
    }
  }

  const requested = options.now instanceof Date ? options.now.getTime() : options.now;
  const now = requested !== undefined && Number.isFinite(requested) ? requested : Date.now();

  return { field: options.field, locale, timeZone, now };
}

function renderScalar(
  value: ScalarValue,
  env: RenderEnv,
  verbatim: boolean,
  nameless: () => void,
): string {
  const { field } = env;

  switch (value.type) {
    case 'text':
      if (verbatim || field === 'plain_text' || field === 'channel_name') return value.value;
      return field === 'url' ? encodeUrlPart(value.value) : escapeDiscordMarkdown(value.value);
    case 'markdown':
      return field === 'url' ? encodeUrlPart(value.value) : value.value;
    case 'mention':
      if (field === 'discord_text') return value.value;
      if (value.name === undefined || value.name === '') {
        nameless();
        return '';
      }
      return value.name;
    case 'url':
    case 'image_url':
      return field === 'discord_text' ? encodeMassMentions(value.value) : value.value;
    case 'integer':
      return plainInteger(value.value);
    case 'number':
      return verbatim || field === 'url'
        ? plainInteger(value.value)
        : plainNumber(value.value, env.locale);
    case 'percent':
      return percentText(value.value, env.locale, false);
    case 'boolean':
      if (verbatim) return String(value.value);
      return value.value ? 'Yes' : 'No';
    case 'datetime':
      return formatDateTime(value.value, 'default', field === 'discord_text', env);
    case 'duration':
      return readableDuration(value.value);
  }
}

const ABSENCE: Record<Exclude<AbsentState, 'unknown_key'>, [DiagnosticCode, string]> = {
  unavailable: ['unavailable', 'is not available here'],
  not_set: ['not_set', 'has no value'],
  restricted: ['restricted', 'may not be shown here'],
  failed: ['resolver_failed', 'could not be resolved'],
};

function outcome(plan: ModifierPlan): string {
  return plan.fallback === undefined ? 'renders as nothing' : 'renders its fallback';
}

function ask(
  lookup: PlaceholderLookup,
  resolution: PlaceholderResolution,
  token: PlaceholderToken,
  plan: ModifierPlan,
  reporter: DiagnosticReporter,
): Extract<ReadValue, { ok: true }> | undefined {
  let answer: unknown;

  try {
    answer = lookup({
      key: resolution.key,
      canonical: resolution.canonical,
      definition: resolution.definition,
      params: resolution.params,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'the lookup threw';
    reporter.report(
      'resolver_failed',
      `${token.raw} could not be read (${reason}), so it ${outcome(plan)}.`,
      token.span,
    );
    return undefined;
  }

  const read = readResolved(answer);
  if (read.ok) return read;

  const problem = read.problem ?? 'is not a valid placeholder value';
  reporter.report(
    'invalid_value',
    `the value supplied for ${token.raw} ${problem}, so it ${outcome(plan)}.`,
    token.span,
  );
  return undefined;
}

function reportAbsence(
  absent: AbsentValue,
  state: Exclude<AbsentState, 'unknown_key'>,
  token: PlaceholderToken,
  plan: ModifierPlan,
  reporter: DiagnosticReporter,
): void {
  const [code, phrase] = ABSENCE[state];
  const reason = absent.reason === undefined ? '' : ` (${absent.reason})`;

  reporter.report(code, `${token.raw} ${phrase}${reason}, so it ${outcome(plan)}.`, token.span);
}

function renderPlaceholder(
  token: PlaceholderToken,
  context: BindContext,
  lookup: PlaceholderLookup,
  env: RenderEnv,
  reporter: DiagnosticReporter,
  unknown: Set<string>,
): Piece {
  const bound = bindPlaceholder(token, context, reporter);

  if (bound.kind === 'literal') {
    if (bound.unknown) unknown.add(token.key);
    return authored(token.raw);
  }

  const fallback = authored(bound.plan.fallback ?? '');
  if (bound.kind === 'absent') return fallback;

  const { resolution, plan, verbatim } = bound;

  const read = ask(lookup, resolution, token, plan, reporter);
  if (read === undefined) return fallback;

  const { resolved, total } = read;

  if (resolved.type === 'absent') {
    const { state } = resolved;

    if (state === 'unknown_key') {
      reporter.report(
        'unknown_placeholder',
        `${token.raw} has no value here, so it is posted as written.`,
        token.span,
      );
      unknown.add(token.key);
      return authored(token.raw);
    }

    reportAbsence(resolved, state, token, plan, reporter);
    return fallback;
  }

  const expected = resolution.definition.type;

  if (typeOf(resolved) !== expected) {
    reporter.report(
      'invalid_value',
      `${token.raw} should be ${describeType(expected)}, but the value supplied is ` +
        `${describeType(typeOf(resolved))}, so it ${outcome(plan)}.`,
      token.span,
    );
    return fallback;
  }

  const bounded = plan.steps.some((step) => step.name === 'count' || step.name === 'limit');

  if (resolved.type === 'list' && total > PLACEHOLDER_LIMITS.listItems && !bounded) {
    reporter.report(
      'list_truncated',
      `${token.raw} holds ${total} items; only the first ${PLACEHOLDER_LIMITS.listItems} are written.`,
      token.span,
    );
  }

  const nameless = (): void =>
    reporter.report(
      'mention_without_name',
      `${token.raw} is a mention with no readable name, so it renders as nothing in ${FIELD_LABELS[env.field]}.`,
      token.span,
    );

  let flow: Flow = { kind: 'value', value: resolved, total };
  const stepEnv = {
    ...env,
    renderItem: (item: ScalarValue) => renderScalar(item, env, false, nameless),
  };

  for (const step of plan.steps) flow = applyStep(flow, step, stepEnv);

  if (flow.kind === 'formatted') return { text: flow.text, authored: flow.authored };

  const { value } = flow;

  if (value.type === 'list') {
    return substituted(
      value.items.map((item) => renderScalar(item, env, verbatim, nameless)).join(', '),
    );
  }

  return substituted(renderScalar(value, env, verbatim, nameless));
}

function assemble(pieces: readonly Piece[], field: TemplateField): string {
  const injected: Array<readonly [number, number]> = [];
  let text = '';

  for (const piece of pieces) {
    if (!piece.authored && piece.text !== '') {
      injected.push([text.length, text.length + piece.text.length]);
    }
    text += piece.text;
  }

  if (field !== 'discord_text') return text;

  return breakMassMentions(text, (start, end) =>
    injected.some(([from, to]) => from < end && to > start),
  );
}

function finish(output: string, options: RenderOptions, reporter: DiagnosticReporter): string {
  if (options.field === 'channel_name') {
    const name = normaliseChannelName(output, options.channel ?? 'text');

    if (name === '') {
      reporter.report(
        'empty_channel_name',
        'this channel name is empty once rendered, and Discord needs 1 to 100 characters.',
        null,
      );
    }

    return name;
  }

  if (options.field === 'url') {
    const url = output.trim();
    if (url === '' || isHttpUrl(url)) return url;

    reporter.report(
      'invalid_url',
      'this link does not render to an http or https address, so it is left empty.',
      null,
    );
    return '';
  }

  return output;
}

export function renderTemplate(
  template: string | ParsedTemplate,
  lookup: PlaceholderLookup,
  options: RenderOptions,
): RenderResult {
  const parsed =
    typeof template === 'string' ? parseTemplate(template, options.registry) : template;
  const reporter = createReporter(parsed.diagnostics);
  const env = environment(options, reporter);

  const context: BindContext = {
    registry: options.registry,
    field: options.field,
    event: options.event,
    audience: options.audience,
  };

  const unknown = new Set<string>();
  const max = PLACEHOLDER_LIMITS.outputLength;
  const cut = `the rendered text passed ${max} characters, so everything after that was cut.`;
  const pieces: Piece[] = [];
  let length = 0;
  let truncated = false;

  for (const token of parsed.tokens) {
    let piece = authored('');

    if (token.kind === 'text') {
      piece = authored(token.text);
    } else {
      try {
        piece = renderPlaceholder(token, context, lookup, env, reporter, unknown);
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'rendering threw';
        reporter.report(
          'resolver_failed',
          `${token.raw} could not be rendered (${reason}), so it renders as nothing.`,
          token.span,
        );
      }
    }

    if (length + piece.text.length > max) {
      pieces.push({ text: clip(piece.text, max - length), authored: piece.authored });
      reporter.report('output_truncated', cut, token.span);
      truncated = true;
      break;
    }

    pieces.push(piece);
    length += piece.text.length;
  }

  let output = assemble(pieces, options.field);

  if (output.length > max) {
    output = clip(output, max);
    if (!truncated) reporter.report('output_truncated', cut, null);
  }

  return {
    output: finish(output, options, reporter),
    diagnostics: reporter.diagnostics,
    unknown: [...unknown],
  };
}
