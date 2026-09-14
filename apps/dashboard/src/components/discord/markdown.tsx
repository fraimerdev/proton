import type { ReactElement, ReactNode } from 'react';
import { useSyncExternalStore } from 'react';

export type MentionNames = ReadonlyMap<string, string>;

export interface MarkdownContext {
  mentionNames?: MentionNames | undefined;
  now?: number | undefined;
}

interface InlineOptions extends MarkdownContext {
  rich: boolean;
}

export interface TimestampFormat {
  locale?: string | undefined;
  timeZone?: string | undefined;
}

const RULES = [
  ['escape', /\\[^0-9A-Za-z\s]/],
  ['codeblock', /```(?:[a-z0-9+-]*\n)?[\s\S]*?```/],
  ['code', /`[^`\n]+`/],
  ['boldItalic', /\*\*\*(?:\\[\s\S]|[^*\\])+\*\*\*/],
  ['bold', /\*\*(?:\\[\s\S]|[^*\\])+\*\*/],
  ['underline', /__(?:\\[\s\S]|[^_\\])+__/],
  ['italic', /\*(?:\\[^\n]|[^*\\\n])+\*|_(?:\\[^\n]|[^_\\\n])+_/],
  ['strike', /~~(?:\\[\s\S]|[^~\\])+~~/],
  ['spoiler', /\|\|[\s\S]+?\|\|/],
  ['emoji', /<a?:\w+:\d+>/],
  ['user', /<@!?\d+>/],
  ['role', /<@&\d+>/],
  ['channel', /<#\d+>/],
  ['timestamp', /<t:-?\d+(?::[tTdDfFR])?>/],
  ['link', /https?:\/\/\S+/],
] as const;

type TokenKind = (typeof RULES)[number][0];

const TOKEN = new RegExp(RULES.map(([, rule]) => `(${rule.source})`).join('|'), 'g');

const FENCE = /```(?:[a-z0-9+-]*\n)?[\s\S]*?```/g;

const DATE_STYLES: Readonly<Record<string, Intl.DateTimeFormatOptions>> = {
  t: { timeStyle: 'short' },
  T: { timeStyle: 'medium' },
  d: { dateStyle: 'short' },
  D: { dateStyle: 'long' },
  F: { dateStyle: 'full', timeStyle: 'short' },
};

const LONG_DATE_TIME: Intl.DateTimeFormatOptions = { dateStyle: 'long', timeStyle: 'short' };

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

const SECONDS = ['second', 1] as const;

// The server and the hydrating render must print the same text, so the viewer's zone waits for hydration.
const FIRST_PAINT: TimestampFormat = { locale: 'en-GB', timeZone: 'UTC' };

export function formatDiscordTimestamp(
  seconds: number,
  style: string,
  now: number,
  { locale, timeZone }: TimestampFormat = {},
): string | undefined {
  const at = seconds * 1000;
  if (Number.isNaN(new Date(at).getTime())) return undefined;

  if (style === 'R') {
    const delta = seconds - now / 1000;
    const [unit, size] = RELATIVE_UNITS.find(([, span]) => Math.abs(delta) >= span) ?? SECONDS;
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      Math.trunc(delta / size) || 0,
      unit,
    );
  }

  const options = DATE_STYLES[style] ?? LONG_DATE_TIME;
  return new Intl.DateTimeFormat(
    locale,
    timeZone === undefined ? options : { ...options, timeZone },
  ).format(at);
}

const subscribeToNothing = (): (() => void) => () => undefined;

function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}

function Timestamp({ token, now }: { token: string; now: number | undefined }): ReactElement {
  const hydrated = useHydrated();
  const [, digits = '', style = 'f'] = /^<t:(-?\d+)(?::(\w))?>$/.exec(token) ?? [];
  const seconds = Number(digits);

  const text = hydrated
    ? formatDiscordTimestamp(seconds, style, now ?? Date.now())
    : formatDiscordTimestamp(
        seconds,
        style === 'R' && now === undefined ? 'f' : style,
        now ?? 0,
        FIRST_PAINT,
      );

  return <span className="dc-mention">{text ?? token}</span>;
}

function emoji(token: string): ReactElement {
  const match = /^<(a)?:(\w+):(\d+)>$/.exec(token);
  const animated = match?.[1] === 'a';
  const name = match?.[2] ?? 'emoji';
  const id = match?.[3] ?? '';

  return (
    <img
      src={`https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'webp'}?size=44`}
      alt={`:${name}:`}
      title={`:${name}:`}
      style={{ display: 'inline-block', width: '1.375em', height: '1.375em', verticalAlign: -4 }}
    />
  );
}

function mention(
  kind: 'user' | 'role' | 'channel',
  token: string,
  names: MentionNames | undefined,
): string {
  const id = /\d+/.exec(token)?.[0];
  const name = id === undefined ? undefined : names?.get(id);
  return `${kind === 'channel' ? '#' : '@'}${name ?? kind}`;
}

function codeBody(fence: string): string {
  return fence.replace(/^```(?:[a-z0-9+-]*\n)?/, '').replace(/```$/, '');
}

function kindOf(match: RegExpMatchArray): TokenKind {
  const at = RULES.findIndex((_, index) => match[index + 1] !== undefined);
  return RULES[at]?.[0] ?? 'link';
}

function tokenNode(kind: TokenKind, token: string, key: string, options: InlineOptions): ReactNode {
  switch (kind) {
    case 'escape':
      return token.slice(1);
    case 'codeblock':
      return (
        <span className="dc-codeblock" key={key}>
          {codeBody(token)}
        </span>
      );
    case 'code':
      return (
        <span className="dc-code" key={key}>
          {token.slice(1, -1)}
        </span>
      );
    case 'boldItalic':
      return (
        <strong key={key}>
          <em>{inline(token.slice(3, -3), key, options)}</em>
        </strong>
      );
    case 'bold':
      return <strong key={key}>{inline(token.slice(2, -2), key, options)}</strong>;
    case 'underline':
      return <u key={key}>{inline(token.slice(2, -2), key, options)}</u>;
    case 'italic':
      return <em key={key}>{inline(token.slice(1, -1), key, options)}</em>;
    case 'strike':
      return <s key={key}>{inline(token.slice(2, -2), key, options)}</s>;
    case 'spoiler':
      return (
        <span
          key={key}
          style={{ background: 'var(--dc-bg-tertiary)', borderRadius: 3, color: 'transparent' }}
          title="Spoiler"
        >
          {token.slice(2, -2)}
        </span>
      );
    case 'emoji':
      return <span key={key}>{emoji(token)}</span>;
    case 'user':
    case 'role':
    case 'channel':
      return options.rich ? (
        <span className="dc-mention" key={key}>
          {mention(kind, token, options.mentionNames)}
        </span>
      ) : (
        token
      );
    case 'timestamp':
      return options.rich ? <Timestamp key={key} token={token} now={options.now} /> : token;
    case 'link':
      return options.rich ? (
        <a className="dc-link" href={token} key={key} rel="noreferrer noopener" target="_blank">
          {token}
        </a>
      ) : (
        token
      );
  }
}

function inline(text: string, keyPrefix: string, options: InlineOptions): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  const push = (node: ReactNode): void => {
    const last = out.length - 1;
    const previous = out[last];
    if (typeof node === 'string' && typeof previous === 'string') out[last] = `${previous}${node}`;
    else out.push(node);
  };

  for (const match of text.matchAll(TOKEN)) {
    const at = match.index;
    if (at > cursor) push(text.slice(cursor, at));

    const token = match[0];
    push(tokenNode(kindOf(match), token, `${keyPrefix}-${index++}`, options));
    cursor = at + token.length;
  }

  if (cursor < text.length) push(text.slice(cursor));
  return out;
}

function lineBlocks(text: string, options: InlineOptions): ReactNode[] {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let quote: string[] = [];

  const flushQuote = (at: number): void => {
    if (quote.length === 0) return;
    blocks.push(
      <span className="dc-blockquote" key={`q-${at}`}>
        <span>{inline(quote.join('\n'), `q-${at}`, options)}</span>
      </span>,
    );
    quote = [];
  };

  lines.forEach((line, index) => {
    if (line.startsWith('> ')) {
      quote.push(line.slice(2));
      return;
    }

    flushQuote(index);

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      blocks.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's position in the text is its identity
        <span className={`dc-heading-${level}`} key={index}>
          {inline(heading[2] ?? '', `h-${index}`, options)}
        </span>,
      );
      return;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's position in the text is its identity
        <span key={index} style={{ display: 'block', paddingLeft: 16, textIndent: -10 }}>
          {'• '}
          {inline(bullet[1] ?? '', `b-${index}`, options)}
        </span>,
      );
      return;
    }

    const subtext = /^-#\s+(.*)$/.exec(line);
    if (subtext) {
      blocks.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's position in the text is its identity
        <span className="dc-small" key={index} style={{ display: 'block' }}>
          {inline(subtext[1] ?? '', `s-${index}`, options)}
        </span>,
      );
      return;
    }

    // biome-ignore lint/suspicious/noArrayIndexKey: a line's position in the text is its identity
    blocks.push(<span key={index}>{inline(line, `l-${index}`, options)}</span>);
  });

  flushQuote(lines.length);
  return blocks;
}

export function InlineDiscordMarkdown({ text }: { text: string }): ReactElement {
  return <>{inline(text, 'i', { rich: false })}</>;
}

export function DiscordMarkdown({
  text,
  mentionNames,
  now,
}: { text: string } & MarkdownContext): ReactElement | null {
  if (text.trim() === '') return null;

  const options: InlineOptions = { mentionNames, now, rich: true };
  const blocks: ReactNode[] = [];
  let cursor = 0;

  const prose = (segment: string): void => {
    if (segment !== '') blocks.push(...lineBlocks(segment, options));
  };

  for (const fence of text.matchAll(FENCE)) {
    prose(text.slice(cursor, fence.index).replace(/\n$/, ''));
    blocks.push(
      <span className="dc-codeblock" key={`code-${fence.index}`}>
        {codeBody(fence[0])}
      </span>,
    );
    cursor = fence.index + fence[0].length;
    if (text.charAt(cursor) === '\n') cursor += 1;
  }

  prose(text.slice(cursor));

  return (
    <>
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the block's index is its identity here
        <span key={index} style={{ display: 'block' }}>
          {block}
        </span>
      ))}
    </>
  );
}
