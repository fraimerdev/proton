import { CHANNEL_NAME_MAX, type ChannelKind, URL_MAX } from './limits.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface FormatEnv {
  locale: string;
  timeZone: string;
  now: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;

  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

export function escapeTemplateText(text: string): string {
  return text.replaceAll('{', '{{').replaceAll('}', '}}');
}

const MASS_MENTION = /@(everyone|here)/gi;

export function breakMassMentions(
  text: string,
  injected: (start: number, end: number) => boolean = () => true,
): string {
  return text.replace(MASS_MENTION, (match: string, word: string, offset: number) =>
    injected(offset, offset + match.length) ? `@​${word}` : match,
  );
}

export function encodeMassMentions(url: string): string {
  return url.replace(MASS_MENTION, '%40$1');
}

const MARKDOWN_ANYWHERE = /[\\*_~`|<>[\]:]/g;

const MARKDOWN_LINE_START = /^([ \t]*)(?:([#+-])|(\d+)\.)/gm;

export function escapeDiscordMarkdown(text: string): string {
  return breakMassMentions(
    text
      .replace(MARKDOWN_ANYWHERE, (character) => `\\${character}`)
      .replace(
        MARKDOWN_LINE_START,
        (_match: string, indent: string, sign: string | undefined, digits: string | undefined) =>
          sign === undefined ? `${indent}${digits ?? ''}\\.` : `${indent}\\${sign}`,
      ),
  );
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function encodeUrlPart(text: string): string {
  return encodeURIComponent(text.replace(LONE_SURROGATE, '�'));
}

const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

// Joiners, variation selectors and tag characters are invisible but hold an emoji sequence together.
const VOICE_INVISIBLE = /(?!‌|‍|️|[\u{E0020}-\u{E007F}])[\p{Cc}\p{Cf}]/gu;

const TEXT_CHANNEL_PUNCTUATION = /[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g;

export function normaliseChannelName(raw: string, kind: ChannelKind): string {
  if (kind === 'voice') {
    const name = raw.replace(/\s/gu, ' ').replace(VOICE_INVISIBLE, '').trim();
    return clip(name, CHANNEL_NAME_MAX).trimEnd();
  }

  const name = raw
    .toLowerCase()
    .replace(/\s+/gu, '-')
    .replace(INVISIBLE, '')
    .replace(TEXT_CHANNEL_PUNCTUATION, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return clip(name, CHANNEL_NAME_MAX).replace(/-+$/, '');
}

export function isHttpUrl(text: string): boolean {
  if (text.length > URL_MAX || !/^https?:\/\/[^\s<>"]+$/i.test(text)) return false;

  try {
    const url = new URL(text);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The types always declare Intl.Segmenter, but older browsers do not ship it.
const GRAPHEMES =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'grapheme' })
    : undefined;

function characters(text: string): string[] {
  return GRAPHEMES === undefined
    ? Array.from(text)
    : Array.from(GRAPHEMES.segment(text), ({ segment }) => segment);
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;

  const kept = characters(text);
  if (kept.length <= max) return text;

  return `${kept
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`;
}

function unsigned(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function plainInteger(value: number): string {
  return String(unsigned(value));
}

export function plainNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 2 }).format(
    unsigned(value),
  );
}

export function groupedNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(unsigned(value));
}

export function compactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
    unsigned(value),
  );
}

const ORDINAL_SUFFIX: Record<Intl.LDMLPluralRule, string> = {
  zero: 'th',
  one: 'st',
  two: 'nd',
  few: 'rd',
  many: 'th',
  other: 'th',
};

const ORDINAL_RULES = new Intl.PluralRules('en-US', { type: 'ordinal' });

export function ordinalNumber(value: number): string {
  return `${groupedNumber(value, 'en-US')}${ORDINAL_SUFFIX[ORDINAL_RULES.select(unsigned(value))]}`;
}

export function percentText(value: number, locale: string, grouped: boolean): string {
  return `${grouped ? groupedNumber(value, locale) : plainNumber(value, locale)}%`;
}

export const DATE_STYLES = ['default', 'full', 'date', 'time'] as const;

export type DateStyle = (typeof DATE_STYLES)[number];

const DISCORD_TIMESTAMP_STYLE: Record<DateStyle, string> = {
  default: 'f',
  full: 'F',
  date: 'd',
  time: 't',
};

const INTL_DATE_STYLE: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  default: { dateStyle: 'medium', timeStyle: 'short' },
  full: { dateStyle: 'full', timeStyle: 'short' },
  date: { dateStyle: 'medium' },
  time: { timeStyle: 'short' },
};

export function unixSeconds(ms: number): number {
  return unsigned(Math.floor(ms / SECOND));
}

export function formatDateTime(
  ms: number,
  style: DateStyle,
  discord: boolean,
  env: FormatEnv,
): string {
  if (discord) return `<t:${unixSeconds(ms)}:${DISCORD_TIMESTAMP_STYLE[style]}>`;

  return new Intl.DateTimeFormat(env.locale, {
    ...INTL_DATE_STYLE[style],
    timeZone: env.timeZone,
  }).format(ms);
}

const RELATIVE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * DAY],
  ['month', 30 * DAY],
  ['week', 7 * DAY],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
  ['second', SECOND],
];

export function formatRelative(ms: number, discord: boolean, env: FormatEnv): string {
  if (discord) return `<t:${unixSeconds(ms)}:R>`;

  const difference = ms - env.now;
  const [unit, size] = RELATIVE_UNITS.find(([, span]) => Math.abs(difference) >= span) ?? [
    'second',
    SECOND,
  ];

  return new Intl.RelativeTimeFormat(env.locale, { numeric: 'always' }).format(
    unsigned(Math.trunc(difference / size)),
    unit,
  );
}

const DURATION_UNITS = [
  ['d', DAY],
  ['h', HOUR],
  ['m', MINUTE],
  ['s', SECOND],
] as const;

export function readableDuration(ms: number): string {
  let rest = Math.abs(ms);
  const parts: string[] = [];

  for (const [suffix, size] of DURATION_UNITS) {
    if (parts.length === 2) break;

    const amount = Math.floor(rest / size);
    if (amount === 0) continue;

    parts.push(`${amount}${suffix}`);
    rest -= amount * size;
  }

  if (parts.length === 0) return '0s';
  return `${ms < 0 ? '-' : ''}${parts.join(' ')}`;
}
