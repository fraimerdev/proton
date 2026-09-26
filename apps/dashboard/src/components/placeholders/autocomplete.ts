import {
  definitionsFor,
  modifierChoices,
  type PlaceholderDefinition,
  type PlaceholderLookup,
  type PlaceholderSurface,
  rendersLink,
  renderTemplate,
  SAMPLE_NOW,
  type Span,
  type TemplateFieldSpec,
  unavailableReason,
} from '@proton/core/placeholders';

export interface DynamicPlaceholder {
  key: string;
  label: string;
}

export type FragmentKind = 'placeholder' | 'modifier';

export interface OpenPlaceholder {
  kind: FragmentKind;
  token: number;
  start: number;
  caret: number;
  end: number;
  query: string;
  word: string;
  closed: boolean;
  key: string;
  previous: readonly string[];
  prefix: string;
}

export interface Dismissal {
  kind: FragmentKind;
  start: number;
  word: string;
}

export interface SuggestionOption {
  kind: FragmentKind;
  key: string;
  insert: string;
  token: string;
  label: string;
  description: string;
  group: string;
  aliases: readonly string[];
  keywords: readonly string[];
  takesArguments: boolean;
  definition: PlaceholderDefinition | undefined;
}

export interface SuggestionGroup {
  label: string;
  options: SuggestionOption[];
}

export interface SuggestionReplacement {
  start: number;
  end: number;
  text: string;
  value: string;
  caret: number;
}

export interface PlaceholderFieldAria {
  role?: 'combobox' | undefined;
  'aria-autocomplete': 'list';
  'aria-expanded'?: boolean | undefined;
  'aria-controls'?: string | undefined;
  'aria-activedescendant'?: string | undefined;
}

export interface SuggestionAnchor {
  top: number;
  bottom: number;
  left: number;
  fieldLeft: number;
  fieldWidth: number;
}

export interface SuggestionViewport {
  width: number;
  height: number;
  top?: number | undefined;
}

export interface SuggestionPlacement {
  top: number;
  left: number;
  width: number | undefined;
  maxHeight: number;
}

export type SuggestionSurface = Pick<
  PlaceholderSurface<unknown>,
  'registry' | 'event' | 'audience'
>;

export const PLACEHOLDER_HINT = 'Type { to insert a placeholder.';

export const MATCH_LIMIT = 40;

export const BROWSE_LIMIT = 150;

export const SUGGESTION_LIST_MAX = 360;

export const NARROW_VIEWPORT = 560;

export const MODIFIER_GROUP = 'Modifiers';

const GAP = 4;

const EDGE = 8;

const LIST_MIN = 96;

const SCAN_LIMIT = 600;

const ROW_DESCRIPTION = 60;

const KEY_CHARACTER = /^[A-Za-z0-9_.]$/;

const NAME_CHARACTER = /^[A-Za-z_]$/;

const NUMBER_CHARACTER = /^[0-9.-]$/;

const WORD_BREAK = /[^\p{L}\p{N}]+/u;

function isKeyCharacter(character: string): boolean {
  return KEY_CHARACTER.test(character);
}

function isNameCharacter(character: string): boolean {
  return NAME_CHARACTER.test(character);
}

// The grammar pairs a run of { from its left end, so only the last brace of an odd run opens.
function opensPlaceholder(value: string, index: number): boolean {
  if (value.charAt(index) !== '{' || value.charAt(index + 1) === '{') return false;

  let braces = 0;
  while (value.charAt(index - braces) === '{') braces += 1;
  return braces % 2 === 1;
}

function afterQuoted(value: string, at: number): number {
  let index = at + 1;

  while (index < value.length) {
    const character = value.charAt(index);
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '"') return index + 1;
    index += 1;
  }

  return -1;
}

function afterArguments(value: string, open: number): number {
  let index = open + 1;

  while (index < value.length && index - open < SCAN_LIMIT) {
    const character = value.charAt(index);

    if (character === ')') return index + 1;

    if (character === '"') {
      index = afterQuoted(value, index);
      if (index < 0) return -1;
      continue;
    }

    if (character === ',' || character === ' ' || NUMBER_CHARACTER.test(character)) {
      index += 1;
      continue;
    }

    return -1;
  }

  return -1;
}

function prefixOfToken(
  value: string,
  from: number,
  to: number,
): { key: string; previous: string[] } | null {
  let at = from;
  while (at < to && isKeyCharacter(value.charAt(at))) at += 1;
  if (at === from) return null;

  const key = value.slice(from, at);
  const previous: string[] = [];

  while (at < to) {
    if (value.charAt(at) !== ':') return null;
    at += 1;

    const name = at;
    while (at < to && isNameCharacter(value.charAt(at))) at += 1;
    if (at === name) return null;
    previous.push(value.slice(name, at));

    if (value.charAt(at) === '(') {
      const after = afterArguments(value, at);
      if (after < 0 || after > to) return null;
      at = after;
    }
  }

  return at === to ? { key, previous } : null;
}

export function closingBraceAfter(value: string, from: number): number {
  let index = from;

  while (index < value.length && index - from < SCAN_LIMIT) {
    const character = value.charAt(index);

    if (character === '"') {
      index = afterQuoted(value, index);
      if (index < 0) return from;
      continue;
    }

    if (character === '}') return index + 1;
    if (character === '{') return from;
    index += 1;
  }

  return from;
}

function placeholderAt(value: string, caret: number): OpenPlaceholder | null {
  let first = caret;
  while (first > 0 && isKeyCharacter(value.charAt(first - 1))) first -= 1;

  const start = first - 1;
  if (start < 0 || !opensPlaceholder(value, start)) return null;

  let end = caret;
  while (isKeyCharacter(value.charAt(end))) end += 1;

  const after = value.charAt(end);

  return {
    kind: 'placeholder',
    token: start,
    start,
    caret,
    end,
    query: value.slice(first, caret),
    word: value.slice(first, end),
    closed: after === '}' || after === ':',
    key: '',
    previous: [],
    prefix: '',
  };
}

function modifierAt(value: string, caret: number): OpenPlaceholder | null {
  let start = caret;
  while (start > 0 && isNameCharacter(value.charAt(start - 1))) start -= 1;

  const colon = start - 1;
  if (colon < 1 || value.charAt(colon) !== ':') return null;

  for (
    let token = value.lastIndexOf('{', colon - 1);
    token >= 0 && colon - token <= SCAN_LIMIT;
    // lastIndexOf reads a negative start as 0, so the first character would be found for ever.
    token = token === 0 ? -1 : value.lastIndexOf('{', token - 1)
  ) {
    if (!opensPlaceholder(value, token)) continue;

    const prefix = prefixOfToken(value, token + 1, colon);
    if (prefix === null) continue;

    let end = caret;
    while (isNameCharacter(value.charAt(end))) end += 1;

    if (value.charAt(end) === '(') {
      const after = afterArguments(value, end);
      if (after > 0) end = after;
    }

    const next = value.charAt(end);

    return {
      kind: 'modifier',
      token,
      start,
      caret,
      end,
      query: value.slice(start, caret),
      word: value.slice(start, end),
      closed: next === '}' || next === ':',
      key: prefix.key,
      previous: prefix.previous,
      prefix: value.slice(token + 1, colon),
    };
  }

  return null;
}

export function openPlaceholderAt(value: string, caret: number): OpenPlaceholder | null {
  if (!Number.isInteger(caret) || caret < 1 || caret > value.length) return null;
  return placeholderAt(value, caret) ?? modifierAt(value, caret);
}

export function pendingSpan(value: string, open: OpenPlaceholder): Span {
  const end = open.closed ? closingBraceAfter(value, open.end) : open.end;
  return { start: open.token, end: Math.max(end, open.caret) };
}

function isPattern(key: string): boolean {
  return key.includes('<');
}

function placeholderOption(
  definition: PlaceholderDefinition,
  key: string,
  label: string,
  aliases: readonly string[],
): SuggestionOption {
  return {
    kind: 'placeholder',
    key,
    insert: key,
    token: `{${key}}`,
    label,
    description: definition.description,
    group: definition.group,
    aliases,
    keywords: definition.keywords,
    takesArguments: false,
    definition,
  };
}

export function suggestionOptions(
  surface: SuggestionSurface,
  spec: Pick<TemplateFieldSpec, 'kind'>,
  dynamic: readonly DynamicPlaceholder[] = [],
  startsLink = false,
): SuggestionOption[] {
  const offered = definitionsFor(surface.registry, {
    field: spec.kind,
    event: surface.event,
    audience: surface.audience,
  }).filter((definition) => !startsLink || rendersLink(definition.type));
  const allowed = new Set(offered);
  const expansions = new Map<PlaceholderDefinition, DynamicPlaceholder[]>();
  const seen = new Set<string>();

  for (const entry of dynamic) {
    if (seen.has(entry.key)) continue;

    const definition = surface.registry.resolve(entry.key)?.definition;
    if (definition === undefined || !isPattern(definition.key) || !allowed.has(definition)) {
      continue;
    }

    seen.add(entry.key);
    expansions.set(definition, [...(expansions.get(definition) ?? []), entry]);
  }

  return offered.flatMap((definition): SuggestionOption[] => {
    if (!isPattern(definition.key)) {
      return [placeholderOption(definition, definition.key, definition.label, definition.aliases)];
    }

    return (expansions.get(definition) ?? []).map((entry) =>
      placeholderOption(definition, entry.key, `${definition.label}: ${entry.label}`, []),
    );
  });
}

export function modifierOptions(
  surface: SuggestionSurface,
  spec: Pick<TemplateFieldSpec, 'kind'>,
  open: Pick<OpenPlaceholder, 'key' | 'previous'>,
): SuggestionOption[] {
  const definition = surface.registry.resolve(open.key)?.definition;
  if (definition === undefined) return [];

  return modifierChoices({
    type: definition.type,
    field: spec.kind,
    allowed: definition.modifiers,
    previous: open.previous,
  }).map((choice) => ({
    kind: 'modifier',
    key: choice.name,
    insert: choice.usage.slice(1),
    token: choice.usage,
    label: choice.description,
    description: choice.description,
    group: MODIFIER_GROUP,
    aliases: [],
    keywords: [],
    takesArguments: choice.takesArguments,
    definition,
  }));
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(WORD_BREAK)
    .filter((word) => word !== '');
}

function placeholderTier(option: SuggestionOption, query: string): number | undefined {
  const key = option.key.toLowerCase();
  const aliases = option.aliases.map((alias) => alias.toLowerCase());

  if (key === query || aliases.includes(query)) return 0;
  if (key.startsWith(query)) return 1;
  if (aliases.some((alias) => alias.startsWith(query))) return 2;

  const segments = key.split('.');
  for (let index = 1; index < segments.length; index += 1) {
    if (segments.slice(index).join('.').startsWith(query)) return 3;
  }

  if (wordsOf(option.label).some((word) => word.startsWith(query))) return 4;
  if (wordsOf(option.group).some((word) => word.startsWith(query))) return 5;
  if (option.keywords.some((keyword) => keyword.startsWith(query))) return 6;
  if (wordsOf(option.description).some((word) => word.startsWith(query))) return 7;
  return key.includes(query) ? 8 : undefined;
}

function modifierTier(option: SuggestionOption, query: string): number | undefined {
  const name = option.key.toLowerCase();

  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (wordsOf(option.description).some((word) => word.startsWith(query))) return 7;
  return name.includes(query) ? 8 : undefined;
}

const TIERS = 9;

export function rankSuggestions(
  options: readonly SuggestionOption[],
  query: string,
  limit?: number | undefined,
): SuggestionOption[] {
  const needle = query.toLowerCase();
  if (needle === '') return options.slice(0, limit ?? BROWSE_LIMIT);

  const tiers: SuggestionOption[][] = Array.from({ length: TIERS }, () => []);
  for (const option of options) {
    const tier =
      option.kind === 'modifier' ? modifierTier(option, needle) : placeholderTier(option, needle);
    if (tier !== undefined) tiers[tier]?.push(option);
  }

  return tiers.flat().slice(0, limit ?? MATCH_LIMIT);
}

export function groupSuggestions(options: readonly SuggestionOption[]): SuggestionGroup[] {
  const groups = new Map<string, SuggestionOption[]>();

  for (const option of options) {
    const listed = groups.get(option.group);
    if (listed === undefined) groups.set(option.group, [option]);
    else listed.push(option);
  }

  return [...groups].map(([label, grouped]) => ({ label, options: grouped }));
}

export function suggestionSample(
  surface: SuggestionSurface,
  spec: Pick<TemplateFieldSpec, 'kind' | 'channel'>,
  option: Pick<SuggestionOption, 'kind' | 'key' | 'insert' | 'definition'>,
  lookup: PlaceholderLookup,
  open?: Pick<OpenPlaceholder, 'prefix'> | undefined,
): string {
  const { definition } = option;

  const readable =
    spec.kind === 'discord_text' &&
    definition !== undefined &&
    unavailableReason(definition, {
      field: 'plain_text',
      event: surface.event,
      audience: surface.audience,
    }) === undefined;

  const template =
    option.kind === 'modifier' && open !== undefined
      ? `{${open.prefix}:${option.insert}}`
      : `{${option.key}}`;

  return renderTemplate(template, lookup, {
    registry: surface.registry,
    field: readable ? 'plain_text' : spec.kind,
    channel: spec.channel,
    event: surface.event,
    audience: surface.audience,
    now: SAMPLE_NOW,
  }).output;
}

export function suggestionReplacement(
  value: string,
  open: Pick<OpenPlaceholder, 'kind' | 'start' | 'end' | 'closed'>,
  option: Pick<SuggestionOption, 'insert'>,
  maxLength: number,
): SuggestionReplacement | null {
  const lead = open.kind === 'placeholder' ? '{' : '';
  const text = `${lead}${option.insert}${open.closed ? '' : '}'}`;
  const next = `${value.slice(0, open.start)}${text}${value.slice(open.end)}`;

  if (maxLength >= 0 && next.length > maxLength) return null;

  const after = open.start + text.length;

  return {
    start: open.start,
    end: open.end,
    text,
    value: next,
    caret: open.closed ? closingBraceAfter(next, after) : after,
  };
}

export function dismissalFor(open: OpenPlaceholder): Dismissal {
  return { kind: open.kind, start: open.start, word: open.word };
}

export function nextDismissal(
  dismissal: Dismissal | null,
  open: OpenPlaceholder | null,
): Dismissal | null {
  if (dismissal === null || open === null) return dismissal;

  return open.kind === dismissal.kind &&
    open.start === dismissal.start &&
    open.word === dismissal.word
    ? dismissal
    : null;
}

export function isListOpen(open: OpenPlaceholder | null, dismissal: Dismissal | null): boolean {
  return open !== null && nextDismissal(dismissal, open) === null;
}

export function wrapIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

export type ListKeyAction = 'next' | 'previous' | 'accept' | 'dismiss';

export type ListKey = Pick<
  KeyboardEvent,
  'key' | 'keyCode' | 'isComposing' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>;

export function listKeyAction(event: ListKey): ListKeyAction | undefined {
  // Safari sends the Enter that commits an IME composition after compositionend, marked only by keyCode 229.
  if (event.isComposing || event.keyCode === 229) return undefined;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;

  switch (event.key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'previous';
    case 'Enter':
      return 'accept';
    case 'Escape':
      return 'dismiss';
    default:
      return undefined;
  }
}

export function interceptsKey(action: ListKeyAction, rows: number): boolean {
  return action === 'dismiss' || rows > 0;
}

export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

export function emptyMessage(kind: FragmentKind): string {
  return kind === 'modifier' ? 'No matching modifiers.' : 'No matching placeholders.';
}

export function suggestionAnnouncement(count: number, kind: FragmentKind = 'placeholder'): string {
  if (count === 0) return emptyMessage(kind);

  const noun = kind === 'modifier' ? 'modifier' : 'placeholder';
  return count === 1 ? `1 ${noun} suggestion` : `${count} ${noun} suggestions`;
}

export function suggestionDetail(
  option: SuggestionOption,
  spec: Pick<TemplateFieldSpec, 'kind'>,
): string[] {
  if (option.kind === 'modifier') {
    return option.takesArguments ? ['Change the example in brackets to your own.'] : [];
  }

  const lines: string[] = [];
  if (option.description.length > ROW_DESCRIPTION) lines.push(option.description);
  if (option.aliases.length > 0) {
    lines.push(`Also works as ${option.aliases.map((alias) => `{${alias}}`).join(', ')}.`);
  }

  const { definition } = option;
  const shaped =
    definition !== undefined &&
    modifierChoices({
      type: definition.type,
      field: spec.kind,
      allowed: definition.modifiers,
      previous: [],
    }).some(({ name }) => name !== 'fallback');
  if (shaped) lines.push('Type : after the name to change how it’s shown.');

  return lines;
}

export function fieldAria({
  multiline,
  open,
  listId,
  active,
}: {
  multiline: boolean;
  open: boolean;
  listId: string;
  active: number;
}): PlaceholderFieldAria {
  if (!open) return { 'aria-autocomplete': 'list' };

  const shared = {
    'aria-autocomplete': 'list',
    'aria-controls': listId,
    'aria-activedescendant': optionId(listId, active),
  } as const;

  return multiline ? shared : { role: 'combobox', 'aria-expanded': true, ...shared };
}

export function placeSuggestions(
  anchor: SuggestionAnchor,
  size: { width: number; height: number },
  viewport: SuggestionViewport,
): SuggestionPlacement {
  const visibleTop = viewport.top ?? 0;
  const visibleBottom = visibleTop + viewport.height;
  const narrow = viewport.width < NARROW_VIEWPORT;
  const width = narrow ? Math.min(anchor.fieldWidth, viewport.width - EDGE * 2) : size.width;
  const height = Math.min(size.height, SUGGESTION_LIST_MAX);

  const below = visibleBottom - anchor.bottom - GAP - EDGE;
  const above = anchor.top - visibleTop - GAP - EDGE;
  const flip = below < height && above > below;

  const room = Math.max(LIST_MIN, Math.min(SUGGESTION_LIST_MAX, flip ? above : below));
  const shown = Math.min(height, room);
  const top = flip ? Math.max(visibleTop + EDGE, anchor.top - GAP - shown) : anchor.bottom + GAP;

  const wanted = narrow ? anchor.fieldLeft : anchor.left;
  const left = Math.min(Math.max(EDGE, wanted), Math.max(EDGE, viewport.width - width - EDGE));

  return { top, left, width: narrow ? width : undefined, maxHeight: room };
}
