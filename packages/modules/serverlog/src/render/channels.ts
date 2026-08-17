import { ServerLogColors } from '../colours.ts';
import {
  channelMention,
  type LogField,
  type LogLine,
  logEmbed,
  roleMention,
  userMention,
} from '../embed.ts';
import { changeOf, num, type RenderInput, type RenderResult, record, str } from './types.ts';

export const CHANNEL_TYPE_NAMES: Record<number, string> = {
  0: 'Text channel',
  2: 'Voice channel',
  4: 'Category',
  5: 'Announcement channel',
  10: 'Announcement thread',
  11: 'Public thread',
  12: 'Private thread',
  13: 'Stage channel',
  15: 'Forum channel',
  16: 'Media channel',
};

export function channelType(type: number | undefined): string {
  return type === undefined ? 'Channel' : (CHANNEL_TYPE_NAMES[type] ?? 'Channel');
}

function channelLines(channel: Record<string, unknown>, id: string): LogLine[] {
  const parentId = str(channel.parent_id);

  return [
    { label: 'Name', mention: channelMention(id), value: `#${str(channel.name) ?? 'unknown'}` },
    { label: 'Id', value: id },
    ...(parentId
      ? [{ label: 'Category', mention: channelMention(parentId), value: parentId }]
      : [{ label: 'Category', value: 'None' }]),
  ];
}

function channelEmbed(
  input: RenderInput,
  action: 'created' | 'deleted',
  colour: number,
): RenderResult | null {
  const channel = record(input.entity);
  const id = str(channel?.id);
  if (!channel || !id) return null;

  return {
    embed: logEmbed({
      subject: channelType(num(channel.type)),
      action,
      colour,
      lines: channelLines(channel, id),
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderChannelCreated(input: RenderInput): RenderResult | null {
  return channelEmbed(input, 'created', ServerLogColors.Add);
}

export function renderChannelDeleted(input: RenderInput): RenderResult | null {
  return channelEmbed(input, 'deleted', ServerLogColors.Remove);
}

const CHANNEL_UPDATE_KEYS: Array<[string, string]> = [
  ['name', 'Name'],
  ['topic', 'Topic'],
  ['nsfw', 'Age restricted'],
  ['rate_limit_per_user', 'Slowmode'],
  ['parent_id', 'Category'],
  ['bitrate', 'Bitrate'],
  ['user_limit', 'User limit'],
];

export function renderChannelUpdated(input: RenderInput): RenderResult | null {
  const channel = record(input.entity);
  const id = str(channel?.id);
  if (!channel || !id) return null;

  const fields: LogField[] = [];
  for (const [key, label] of CHANNEL_UPDATE_KEYS) {
    const { before, after } = changeOf(input.audit, key);
    if (before === undefined && after === undefined) continue;

    fields.push({ name: label, value: `${before ?? 'none'} → ${after ?? 'none'}` });
  }

  return {
    embed: logEmbed({
      subject: channelType(num(channel.type)),
      action: 'updated',
      colour: ServerLogColors.Modify,
      lines: [
        { label: 'Name', mention: channelMention(id), value: `#${str(channel.name) ?? 'unknown'}` },
        { label: 'Id', value: id },
      ],
      ...(fields.length > 0 ? { fields } : {}),
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

function threadEmbed(
  input: RenderInput,
  action: 'created' | 'updated' | 'deleted',
  colour: number,
): RenderResult | null {
  const thread = record(input.entity);
  const id = str(thread?.id);
  if (!thread || !id) return null;

  const parentId = str(thread.parent_id);

  return {
    embed: logEmbed({
      subject: 'Thread',
      action,
      colour,
      lines: [
        { label: 'Name', mention: channelMention(id), value: str(thread.name) ?? 'unknown' },
        { label: 'Id', value: id },
        ...(parentId
          ? [{ label: 'Channel', mention: channelMention(parentId), value: parentId }]
          : [{ label: 'Channel', value: 'Unknown' }]),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderThreadCreated(input: RenderInput): RenderResult | null {
  return threadEmbed(input, 'created', ServerLogColors.Add);
}

export function renderThreadUpdated(input: RenderInput): RenderResult | null {
  return threadEmbed(input, 'updated', ServerLogColors.Modify);
}

export function renderThreadDeleted(input: RenderInput): RenderResult | null {
  return threadEmbed(input, 'deleted', ServerLogColors.Remove);
}

const OVERWRITE_TARGET_ROLE = '0';

function overwriteEmbed(
  input: RenderInput,
  action: 'created' | 'updated' | 'deleted',
  colour: number,
): RenderResult | null {
  const audit = input.audit;
  const channelId = audit?.targetId;
  if (!audit || !channelId) return null;

  const options = audit.options ?? {};
  const targetId = str(options.id);
  const targetType = str(options.type);
  const roleName = str(options.role_name);

  const target: LogLine = targetId
    ? targetType === OVERWRITE_TARGET_ROLE
      ? { label: 'Role', mention: roleMention(targetId), value: roleName ?? targetId }
      : { label: 'Member', mention: userMention(targetId), value: targetId }
    : { label: 'Target', value: 'Unknown' };

  return {
    embed: logEmbed({
      subject: 'Channel permissions',
      action,
      colour,
      lines: [
        { label: 'Channel', mention: channelMention(channelId), value: channelId },
        target,
        { label: 'Changed', value: audit.changes.map((change) => change.key).join(', ') || 'none' },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderOverwriteCreated(input: RenderInput): RenderResult | null {
  return overwriteEmbed(input, 'created', ServerLogColors.Add);
}

export function renderOverwriteUpdated(input: RenderInput): RenderResult | null {
  return overwriteEmbed(input, 'updated', ServerLogColors.Modify);
}

export function renderOverwriteDeleted(input: RenderInput): RenderResult | null {
  return overwriteEmbed(input, 'deleted', ServerLogColors.Remove);
}
