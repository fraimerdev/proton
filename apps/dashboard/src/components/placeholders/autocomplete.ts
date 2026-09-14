import {
  definitionsFor,
  type PlaceholderDefinition,
  type PlaceholderLookup,
  type PlaceholderSurface,
  renderTemplate,
  SAMPLE_NOW,
  type TemplateFieldSpec,
  unavailableReason,
} from '@proton/core/placeholders';

export interface DynamicPlaceholder {
  key: string;
  label: string;
}

export interface SuggestionOption {
  key: string;
  label: string;
  aliases: readonly string[];
  definition: PlaceholderDefinition;
}

export interface OpenPlaceholder {
  start: number;
  caret: number;
  end: number;
  query: string;
  word: string;
}

export interface Dismissal {
  start: number;
  word: string;
}

export interface PlaceholderReplacement {
  start: number;
  end: number;
  token: string;
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

export const SUGGESTION_LIMIT = 8;

export const SUGGESTION_LIST_MAX = 360;

export const NARROW_VIEWPORT = 560;

const GAP = 4;

const EDGE = 8;

const LIST_MIN = 96;

const KEY_CHARACTER = /^[A-Za-z0-9_.]$/;

const WORD_BREAK = /[^\p{L}\p{N}]+/u;

function isKeyCharacter(character: string): boolean {
  return KEY_CHARACTER.test(character);
}

export function openPlaceholderAt(value: string, caret: number): OpenPlaceholder | null {
  if (!Number.isInteger(caret) || caret < 2 || caret > value.length) return null;

  let first = caret;
  while (first > 0 && isKeyCharacter(value.charAt(first - 1))) first -= 1;

  const start = first - 1;
  if (first === caret || value.charAt(start) !== '{') return null;

  let braces = 0;
  while (value.charAt(start - braces) === '{') braces += 1;
  // The grammar reads {{ as a literal brace from the left, so only an odd run leaves a brace that opens.
  if (braces % 2 === 0) return null;

  let end = caret;
  while (isKeyCharacter(value.charAt(end))) end += 1;

  const after = value.charAt(end);
  if (after === '}' || after === ':') return null;

  return {
    start,
    caret,
    end,
    query: value.slice(first, caret),
    word: value.slice(first, end),
  };
}

function isPattern(key: string): boolean {
  return key.includes('<');
}

export function suggestionOptions(
  surface: SuggestionSurface,
  spec: Pick<TemplateFieldSpec, 'kind'>,
  dynamic: readonly DynamicPlaceholder[] = [],
): SuggestionOption[] {
  const offered = definitionsFor(surface.registry, {
    field: spec.kind,
    event: surface.event,
    audience: surface.audience,
  });
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
      return [
        {
          key: definition.key,
          label: definition.label,
          aliases: definition.aliases,
          definition,
        },
      ];
    }

    return (expansions.get(definition) ?? []).map((entry) => ({
      key: entry.key,
      label: `${definition.label}: ${entry.label}`,
      aliases: [],
      definition,
    }));
  });
}

function tierOf(option: SuggestionOption, query: string): number | undefined {
  const key = option.key.toLowerCase();
  if (key.startsWith(query)) return 0;

  if (option.aliases.some((alias) => alias.toLowerCase().startsWith(query))) return 1;

  const segments = key.split('.');
  for (let index = 1; index < segments.length; index += 1) {
    if (segments.slice(index).join('.').startsWith(query)) return 2;
  }

  const words = option.label.toLowerCase().split(WORD_BREAK);
  return words.some((word) => word !== '' && word.startsWith(query)) ? 3 : undefined;
}

export function rankSuggestions(
  options: readonly SuggestionOption[],
  query: string,
  limit: number = SUGGESTION_LIMIT,
): SuggestionOption[] {
  const needle = query.toLowerCase();
  if (needle === '') return [];

  const tiers: SuggestionOption[][] = [[], [], [], []];
  for (const option of options) {
    const tier = tierOf(option, needle);
    if (tier !== undefined) tiers[tier]?.push(option);
  }

  return tiers.flat().slice(0, limit);
}

export function suggestionSample(
  surface: SuggestionSurface,
  spec: Pick<TemplateFieldSpec, 'kind' | 'channel'>,
  option: Pick<SuggestionOption, 'key' | 'definition'>,
  lookup: PlaceholderLookup,
): string {
  const readable =
    spec.kind === 'discord_text' &&
    unavailableReason(option.definition, {
      field: 'plain_text',
      event: surface.event,
      audience: surface.audience,
    }) === undefined;

  return renderTemplate(`{${option.key}}`, lookup, {
    registry: surface.registry,
    field: readable ? 'plain_text' : spec.kind,
    channel: spec.channel,
    event: surface.event,
    audience: surface.audience,
    now: SAMPLE_NOW,
  }).output;
}

export function placeholderReplacement(
  value: string,
  open: Pick<OpenPlaceholder, 'start' | 'end'>,
  key: string,
  maxLength: number,
): PlaceholderReplacement | null {
  const token = `{${key}}`;
  const { start, end } = open;

  if (maxLength >= 0 && value.length - (end - start) + token.length > maxLength) return null;

  return {
    start,
    end,
    token,
    value: `${value.slice(0, start)}${token}${value.slice(end)}`,
    caret: start + token.length,
  };
}

export function dismissalFor(open: OpenPlaceholder): Dismissal {
  return { start: open.start, word: open.word };
}

export function nextDismissal(
  dismissal: Dismissal | null,
  open: OpenPlaceholder | null,
): Dismissal | null {
  if (dismissal === null || open === null) return dismissal;
  return open.start === dismissal.start && open.word === dismissal.word ? dismissal : null;
}

export function isListOpen(
  open: OpenPlaceholder | null,
  dismissal: Dismissal | null,
  count: number,
): boolean {
  return open !== null && count > 0 && nextDismissal(dismissal, open) === null;
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
    case 'Tab':
      return 'accept';
    case 'Escape':
      return 'dismiss';
    default:
      return undefined;
  }
}

export function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

export function suggestionAnnouncement(count: number): string {
  return count === 1 ? '1 placeholder suggestion' : `${count} placeholder suggestions`;
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
  viewport: { width: number; height: number },
): SuggestionPlacement {
  const narrow = viewport.width < NARROW_VIEWPORT;
  const width = narrow ? Math.min(anchor.fieldWidth, viewport.width - EDGE * 2) : size.width;
  const height = Math.min(size.height, SUGGESTION_LIST_MAX);

  const below = viewport.height - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  const flip = below < height && above > below;

  const room = Math.max(LIST_MIN, Math.min(SUGGESTION_LIST_MAX, flip ? above : below));
  const shown = Math.min(height, room);
  const top = flip ? Math.max(EDGE, anchor.top - GAP - shown) : anchor.bottom + GAP;

  const wanted = narrow ? anchor.fieldLeft : anchor.left;
  const left = Math.min(Math.max(EDGE, wanted), Math.max(EDGE, viewport.width - width - EDGE));

  return { top, left, width: narrow ? width : undefined, maxHeight: room };
}
