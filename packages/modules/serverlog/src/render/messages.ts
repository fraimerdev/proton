import { ServerLogColors } from '../colours.ts';
import {
  channelMention,
  jumpUrl,
  type LogField,
  type LogLine,
  logEmbed,
  timestampLine,
  userMention,
} from '../embed.ts';
import { type RenderInput, type RenderResult, record, str } from './types.ts';

export const NOT_CACHED =
  '*not remembered — turn on “Remember recent message text” in Message logs*';

export const ID_LIST_MAX = 40;

function authorLine(author: Record<string, unknown> | null, fallbackId?: string): LogLine {
  const id = str(author?.id) ?? fallbackId;
  if (!id) return { label: 'Author', value: 'Unknown' };

  const username = str(author?.username);
  return { label: 'Author', mention: userMention(id), value: username ? `@${username}` : id };
}

export function renderMessageEdited(input: RenderInput): RenderResult | null {
  const d = record(input.entity);
  const messageId = str(d?.id);
  const channelId = str(d?.channel_id);
  const after = str(d?.content);

  if (!d || !messageId || !channelId || after === undefined) return null;

  const before = input.cached?.content;
  if (before !== undefined && before === after) return null;

  const fields: LogField[] = [
    { name: 'Before', value: before === undefined ? NOT_CACHED : before || '*empty*' },
    { name: 'After', value: after || '*empty*' },
  ];

  return {
    embed: logEmbed({
      subject: 'Message',
      action: 'edited',
      colour: ServerLogColors.Modify,
      lines: [
        authorLine(record(d.author), input.cached?.authorId),
        { label: 'Message', value: messageId },
        {
          label: 'Jump',
          mention: `[\`Jump to\`](${jumpUrl(input.guildId, channelId, messageId)})`,
        },
        { label: 'Channel', mention: channelMention(channelId), value: channelId },
      ],
      fields,
      executor: null,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderMessageDeleted(input: RenderInput): RenderResult | null {
  const d = record(input.entity);
  const messageId = str(d?.id);
  const channelId = str(d?.channel_id);
  if (!d || !messageId || !channelId) return null;

  const cached = input.cached;
  const attachments = cached?.attachments ?? [];

  const fields: LogField[] = [
    { name: 'Content', value: cached ? cached.content || '*empty*' : NOT_CACHED },
    ...(attachments.length > 0
      ? [
          {
            name: attachments.length === 1 ? 'Attachment' : 'Attachments',
            value: attachments.map((file) => `[${file.filename}](${file.url})`).join('\n'),
          },
        ]
      : []),
  ];

  return {
    embed: logEmbed({
      subject: 'Message',
      action: 'deleted',
      colour: ServerLogColors.Remove,
      lines: [
        authorLine(record(d.author), cached?.authorId),
        { label: 'Message', value: messageId },
        ...(cached ? [{ label: 'Sent', mention: timestampLine(cached.createdAt / 1000) }] : []),
        { label: 'Channel', mention: channelMention(channelId), value: channelId },
      ],
      fields,
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderMessagesBulkDeleted(input: RenderInput): RenderResult | null {
  const d = record(input.entity);
  const channelId = str(d?.channel_id);
  const ids = Array.isArray(d?.ids)
    ? d.ids.filter((id): id is string => typeof id === 'string')
    : [];

  if (!channelId || ids.length === 0) return null;

  // One embed with a truncated list, not one embed per message: the fan-out already happened at
  // the gateway and re-fanning it here would bury the log channel.
  const shown = ids.slice(0, ID_LIST_MAX);
  const listed =
    shown.join('\n') +
    (ids.length > shown.length ? `\n…and ${ids.length - shown.length} more` : '');

  return {
    embed: logEmbed({
      subject: 'Messages',
      action: 'bulk deleted',
      colour: ServerLogColors.Remove,
      lines: [
        { label: 'Channel', mention: channelMention(channelId), value: channelId },
        { label: 'Count', value: String(ids.length) },
      ],
      fields: [{ name: 'Message ids', value: listed }],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

function pinEmbed(
  input: RenderInput,
  action: 'pinned' | 'unpinned',
  colour: number,
): RenderResult | null {
  const audit = input.audit;
  if (!audit) return null;

  const options = audit.options ?? {};
  const channelId = str(options.channel_id);
  const messageId = str(options.message_id);
  if (!channelId || !messageId) return null;

  return {
    embed: logEmbed({
      subject: 'Message',
      action,
      colour,
      lines: [
        { label: 'Message', value: messageId },
        {
          label: 'Jump',
          mention: `[\`Jump to\`](${jumpUrl(input.guildId, channelId, messageId)})`,
        },
        { label: 'Channel', mention: channelMention(channelId), value: channelId },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderMessagePinned(input: RenderInput): RenderResult | null {
  return pinEmbed(input, 'pinned', ServerLogColors.Add);
}

export function renderMessageUnpinned(input: RenderInput): RenderResult | null {
  return pinEmbed(input, 'unpinned', ServerLogColors.Remove);
}
