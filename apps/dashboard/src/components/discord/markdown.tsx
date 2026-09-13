import type { ReactElement, ReactNode } from 'react';

/**
 * Enough of Discord's markdown for a preview to be honest about what a message will look like:
 * bold, italic, underline, strike, spoiler, inline code, links, mentions, custom emoji, headings,
 * blockquotes, lists and fenced code. It is a preview, not a renderer — anything it does not know
 * survives as plain text rather than disappearing.
 */

const TOKEN =
  /(```(?:[a-z0-9+-]*\n)?[\s\S]*?```)|(`[^`\n]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(\|\|[\s\S]+?\|\|)|(<a?:\w+:\d+>)|(<@!?\d+>)|(<@&\d+>)|(<#\d+>)|(<t:\d+(?::[tTdDfFR])?>)|(https?:\/\/\S+)/g;

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

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  for (const match of text.matchAll(TOKEN)) {
    const at = match.index;
    if (at > cursor) out.push(text.slice(cursor, at));

    const token = match[0];
    const key = `${keyPrefix}-${index++}`;

    if (match[1] !== undefined) {
      const body = token.replace(/^```(?:[a-z0-9+-]*\n)?/, '').replace(/```$/, '');
      out.push(
        <span className="dc-codeblock" key={key}>
          {body}
        </span>,
      );
    } else if (match[2] !== undefined) {
      out.push(
        <span className="dc-code" key={key}>
          {token.slice(1, -1)}
        </span>,
      );
    } else if (match[3] !== undefined) {
      out.push(
        <strong key={key}>
          <em>{inline(token.slice(3, -3), key)}</em>
        </strong>,
      );
    } else if (match[4] !== undefined) {
      out.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    } else if (match[5] !== undefined) {
      out.push(<u key={key}>{inline(token.slice(2, -2), key)}</u>);
    } else if (match[6] !== undefined || match[7] !== undefined) {
      out.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>);
    } else if (match[8] !== undefined) {
      out.push(<s key={key}>{inline(token.slice(2, -2), key)}</s>);
    } else if (match[9] !== undefined) {
      out.push(
        <span
          key={key}
          style={{ background: 'var(--dc-bg-tertiary)', borderRadius: 3, color: 'transparent' }}
          title="Spoiler"
        >
          {token.slice(2, -2)}
        </span>,
      );
    } else if (match[10] !== undefined) {
      out.push(<span key={key}>{emoji(token)}</span>);
    } else if (match[11] !== undefined || match[12] !== undefined || match[13] !== undefined) {
      // The id is all a preview has; resolving it would mean a member/role/channel lookup per
      // keystroke, and the shape is what the author is checking here.
      const glyph = match[13] !== undefined ? '#' : '@';
      out.push(
        <span className="dc-mention" key={key}>
          {glyph}
          {match[13] !== undefined ? 'channel' : match[12] !== undefined ? 'role' : 'user'}
        </span>,
      );
    } else if (match[14] !== undefined) {
      const seconds = Number(/<t:(\d+)/.exec(token)?.[1] ?? '0');
      out.push(
        <span className="dc-mention" key={key}>
          {new Date(seconds * 1000).toLocaleString()}
        </span>,
      );
    } else {
      out.push(
        <a className="dc-link" href={token} key={key} rel="noreferrer noopener" target="_blank">
          {token}
        </a>,
      );
    }

    cursor = at + token.length;
  }

  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

export function DiscordMarkdown({ text }: { text: string }): ReactElement | null {
  if (text.trim() === '') return null;

  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let quote: string[] = [];

  const flushQuote = (at: number): void => {
    if (quote.length === 0) return;
    blocks.push(
      <span className="dc-blockquote" key={`q-${at}`}>
        <span>{inline(quote.join('\n'), `q-${at}`)}</span>
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
          {inline(heading[2] ?? '', `h-${index}`)}
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
          {inline(bullet[1] ?? '', `b-${index}`)}
        </span>,
      );
      return;
    }

    const subtext = /^-#\s+(.*)$/.exec(line);
    if (subtext) {
      blocks.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's position in the text is its identity
        <span className="dc-small" key={index} style={{ display: 'block' }}>
          {inline(subtext[1] ?? '', `s-${index}`)}
        </span>,
      );
      return;
    }

    // biome-ignore lint/suspicious/noArrayIndexKey: a line's position in the text is its identity
    blocks.push(<span key={index}>{inline(line, `l-${index}`)}</span>);
  });

  flushQuote(lines.length);

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
