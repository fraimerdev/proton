import { ServerLogColors } from '../colours.ts';
import { channelMention, type LogLine, logEmbed, userMention } from '../embed.ts';
import { changeOf, type RenderInput, type RenderResult, record, str } from './types.ts';

function memberLine(input: RenderInput): LogLine | null {
  const d = record(input.entity);
  const user = record(d?.member)?.user;
  const userId = str(d?.user_id) ?? str(record(user)?.id) ?? input.audit?.targetId ?? undefined;
  if (!userId) return null;

  const username = str(record(user)?.username);
  return {
    label: 'Member',
    mention: userMention(userId),
    value: username ? `@${username}` : userId,
  };
}

// Discord sends only the new voice state, never the old one, so a self-move reads as a leave
// followed by a join. Moves are only reported when a moderator performed them (audit 26), which
// is the case worth a log anyway.
export function renderVoiceJoined(input: RenderInput): RenderResult | null {
  const d = record(input.entity);
  const channelId = str(d?.channel_id);
  const member = memberLine(input);
  if (!channelId || !member) return null;

  return {
    embed: logEmbed({
      subject: 'Member',
      action: 'joined a voice channel',
      colour: ServerLogColors.Add,
      lines: [member, { label: 'Channel', mention: channelMention(channelId), value: channelId }],
      executor: null,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderVoiceLeft(input: RenderInput): RenderResult | null {
  const d = record(input.entity);
  if (str(d?.channel_id) !== undefined) return null;

  const member = memberLine(input);
  if (!member) return null;

  return {
    embed: logEmbed({
      subject: 'Member',
      action: 'left voice',
      colour: ServerLogColors.Remove,
      lines: [member],
      executor: null,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderVoiceMovedByModerator(input: RenderInput): RenderResult | null {
  const audit = input.audit;
  if (!audit) return null;

  const options = audit.options ?? {};
  const channelId = str(options.channel_id);
  const count = str(options.count);

  return {
    embed: logEmbed({
      subject: 'Members',
      action: 'moved between voice channels',
      colour: ServerLogColors.Modify,
      lines: [
        { label: 'Count', value: count ?? '1' },
        ...(channelId
          ? [{ label: 'Moved to', mention: channelMention(channelId), value: channelId }]
          : [{ label: 'Moved to', value: 'Unknown' }]),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderVoiceDisconnectedByModerator(input: RenderInput): RenderResult | null {
  const audit = input.audit;
  if (!audit) return null;

  const count = str(audit.options?.count);

  return {
    embed: logEmbed({
      subject: 'Members',
      action: 'disconnected from voice',
      colour: ServerLogColors.Remove,
      lines: [
        { label: 'Count', value: count ?? '1' },
        { label: 'Reason', value: audit.reason ?? 'No reason given' },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

function serverToggle(
  input: RenderInput,
  key: 'mute' | 'deaf',
  subject: string,
): RenderResult | null {
  const targetId = input.audit?.targetId;
  const { after } = changeOf(input.audit, key);
  if (!targetId || after === undefined) return null;

  const on = after === 'true';

  return {
    embed: logEmbed({
      subject,
      action: on ? 'applied' : 'lifted',
      colour: on ? ServerLogColors.Remove : ServerLogColors.Add,
      lines: [
        { label: 'Member', mention: userMention(targetId), value: targetId },
        { label: 'Reason', value: input.audit?.reason ?? 'No reason given' },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderServerMuted(input: RenderInput): RenderResult | null {
  return serverToggle(input, 'mute', 'Server mute');
}

export function renderServerDeafened(input: RenderInput): RenderResult | null {
  return serverToggle(input, 'deaf', 'Server deafen');
}
