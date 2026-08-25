import type { ReactElement, ReactNode } from 'react';
import { type MarkdownNode, parseDiscordMarkdown } from '../../lib/discord-markdown.ts';
import type { DiscordChannel, DiscordRole } from '../form/fields.tsx';

export interface MentionNames {
  channels: readonly DiscordChannel[];
  roles: readonly DiscordRole[];
}

const TIMESTAMP_STYLES: Readonly<Record<string, Intl.DateTimeFormatOptions>> = {
  t: { timeStyle: 'short' },
  T: { timeStyle: 'medium' },
  d: { dateStyle: 'short' },
  D: { dateStyle: 'long' },
  f: { dateStyle: 'long', timeStyle: 'short' },
  F: { dateStyle: 'full', timeStyle: 'short' },
  s: { dateStyle: 'short', timeStyle: 'short' },
  S: { dateStyle: 'short', timeStyle: 'medium' },
};

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['day', 86_400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

function relative(seconds: number, now: number): string {
  const delta = seconds - Math.floor(now / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(delta) >= size) return formatter.format(Math.trunc(delta / size), unit);
  }

  return formatter.format(0, 'second');
}

function formatTimestamp(unix: number, style: string, now: number): string {
  if (style === 'R') return relative(unix, now);

  const options = TIMESTAMP_STYLES[style] ?? TIMESTAMP_STYLES.f;
  return new Intl.DateTimeFormat(undefined, options).format(new Date(unix * 1000));
}

interface RenderContext extends MentionNames {
  now: number;
}

function channelName(id: string, channels: readonly DiscordChannel[]): string {
  return channels.find((channel) => channel.id === id)?.name ?? `unknown-channel`;
}

function roleName(id: string, roles: readonly DiscordRole[]): string | undefined {
  return roles.find((role) => role.id === id)?.name;
}

function renderNodes(nodes: readonly MarkdownNode[], ctx: RenderContext): ReactNode[] {
  return nodes.map((node, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the AST is positional and rebuilt on every keystroke, so position is the only stable identity a node has
    <MarkdownFragment key={index} node={node} ctx={ctx} />
  ));
}

function MarkdownFragment({ node, ctx }: { node: MarkdownNode; ctx: RenderContext }): ReactNode {
  switch (node.kind) {
    case 'text':
      return node.value;

    case 'paragraph':
      return <p className="dc-p">{renderNodes(node.children, ctx)}</p>;

    // Not a real h1/h2/h3: this is a picture of a message, and its headings are not headings of
    // the settings page they are previewed on. The classes carry the whole appearance.
    case 'heading':
      return <p className={`dc-h dc-h${node.level}`}>{renderNodes(node.children, ctx)}</p>;

    case 'subtext':
      return <p className="dc-subtext">{renderNodes(node.children, ctx)}</p>;

    case 'quote':
      return <blockquote className="dc-quote">{renderNodes(node.children, ctx)}</blockquote>;

    case 'list': {
      const items = node.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity beyond their position in the source text
        <li key={index}>{renderNodes(item, ctx)}</li>
      ));

      return node.ordered ? (
        <ol className="dc-list" start={node.start ?? 1}>
          {items}
        </ol>
      ) : (
        <ul className="dc-list">{items}</ul>
      );
    }

    case 'codeBlock':
      return (
        <pre className="dc-codeblock">
          <code>{node.code}</code>
        </pre>
      );

    case 'code':
      return <code className="dc-code">{node.value}</code>;

    case 'bold':
      return <strong>{renderNodes(node.children, ctx)}</strong>;

    case 'italic':
      return <em>{renderNodes(node.children, ctx)}</em>;

    case 'underline':
      return <u>{renderNodes(node.children, ctx)}</u>;

    case 'strike':
      return <s>{renderNodes(node.children, ctx)}</s>;

    case 'spoiler':
      return <span className="dc-spoiler">{renderNodes(node.children, ctx)}</span>;

    // Rendered as a span, not an anchor: the preview must never be a live link out of the
    // dashboard, and an admin-authored href is not a link the reader chose to follow.
    case 'link':
      return (
        <span className="dc-link" title={node.url}>
          {renderNodes(node.children, ctx)}
        </span>
      );

    case 'userMention':
      return <span className="dc-mention">@{node.id}</span>;

    case 'roleMention': {
      const name = roleName(node.id, ctx.roles);
      return <span className="dc-mention">@{name ?? node.id}</span>;
    }

    case 'channelMention':
      return <span className="dc-mention">#{channelName(node.id, ctx.channels)}</span>;

    case 'slashCommand':
      return <span className="dc-mention">/{node.name}</span>;

    case 'emoji':
      return <span className="dc-emoji-name">:{node.name}:</span>;

    case 'timestamp':
      return (
        <span className="dc-timestamp">{formatTimestamp(node.unix, node.style, ctx.now)}</span>
      );

    case 'everyone':
      return <span className="dc-mention">@{node.which}</span>;

    case 'guildNav':
      return <span className="dc-mention">#{node.target}</span>;

    default:
      return null;
  }
}

export interface MarkdownProps extends MentionNames {
  text: string;

  inline?: boolean;
  now?: number;
}

export function Markdown({ text, channels, roles, inline, now }: MarkdownProps): ReactElement {
  const ctx: RenderContext = { channels, roles, now: now ?? Date.now() };
  const nodes = parseDiscordMarkdown(text);

  if (inline) {
    const flattened = nodes.flatMap((node) => (node.kind === 'paragraph' ? node.children : [node]));
    return <>{renderNodes(flattened, ctx)}</>;
  }

  return <>{renderNodes(nodes, ctx)}</>;
}

export interface PlainProps {
  text: string;
}

// Discord renders no markdown in an embed's title, author name or footer — they arrive as literal
// characters, so parsing them here would show bold text the posted embed will not have.
export function Plain({ text }: PlainProps): ReactElement {
  return <>{text}</>;
}
