import { ServerLogColors } from '../colours.ts';
import { type LogLine, logEmbed, userMention } from '../embed.ts';
import { changeOf, type RenderInput, type RenderResult, record, str } from './types.ts';

function targetLines(input: RenderInput): LogLine[] | null {
  const payload = record(input.entity);
  const user = record(payload?.user);

  const id = str(user?.id) ?? input.audit?.targetId ?? undefined;
  if (!id) return null;

  const username = str(user?.username);

  return [
    { label: 'Member', mention: userMention(id), value: username ? `@${username}` : id },
    { label: 'Id', value: id },
  ];
}

function reasonLine(input: RenderInput): LogLine {
  return { label: 'Reason', value: input.audit?.reason ?? 'No reason given' };
}

function moderationEmbed(
  input: RenderInput,
  subject: string,
  action: string,
  colour: number,
): RenderResult | null {
  const lines = targetLines(input);
  if (!lines) return null;

  return {
    embed: logEmbed({
      subject,
      action,
      colour,
      lines: [...lines, reasonLine(input)],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderMemberBanned(input: RenderInput): RenderResult | null {
  return moderationEmbed(input, 'Member', 'banned', ServerLogColors.Remove);
}

export function renderMemberUnbanned(input: RenderInput): RenderResult | null {
  return moderationEmbed(input, 'Member', 'unbanned', ServerLogColors.Add);
}

export function renderMemberKicked(input: RenderInput): RenderResult | null {
  return moderationEmbed(input, 'Member', 'kicked', ServerLogColors.Remove);
}

export function renderBotAdded(input: RenderInput): RenderResult | null {
  const targetId = input.audit?.targetId;
  if (!targetId) return null;

  return {
    embed: logEmbed({
      subject: 'Bot',
      action: 'added',
      colour: ServerLogColors.Add,
      lines: [
        { label: 'Bot', mention: userMention(targetId), value: targetId },
        { label: 'Added by', value: input.executor?.username ?? 'Unknown' },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderMembersPruned(input: RenderInput): RenderResult | null {
  const audit = input.audit;
  if (!audit) return null;

  const options = audit.options ?? {};

  return {
    embed: logEmbed({
      subject: 'Members',
      action: 'pruned',
      colour: ServerLogColors.Remove,
      lines: [
        { label: 'Removed', value: str(options.members_removed) ?? 'unknown' },
        { label: 'Inactive for', value: `${str(options.delete_member_days) ?? '?'} days` },
        reasonLine(input),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

const TIMEOUT_KEY = 'communication_disabled_until';

export function timeoutChange(input: RenderInput): { before?: string; after?: string } {
  return changeOf(input.audit, TIMEOUT_KEY);
}

export function renderMemberTimedOut(input: RenderInput): RenderResult | null {
  const targetId = input.audit?.targetId;
  const { after } = timeoutChange(input);
  if (!targetId || !after || after === 'none') return null;

  const until = Date.parse(after);

  return {
    embed: logEmbed({
      subject: 'Member',
      action: 'timed out',
      colour: ServerLogColors.Modify,
      lines: [
        { label: 'Member', mention: userMention(targetId), value: targetId },
        {
          label: 'Until',
          ...(Number.isNaN(until)
            ? { value: after }
            : { mention: `<t:${Math.floor(until / 1000)}:F>` }),
        },
        reasonLine(input),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderTimeoutRemoved(input: RenderInput): RenderResult | null {
  const targetId = input.audit?.targetId;
  const { before, after } = timeoutChange(input);
  if (!targetId || before === undefined) return null;
  if (after !== undefined && after !== 'none') return null;

  return {
    embed: logEmbed({
      subject: 'Timeout',
      action: 'removed',
      colour: ServerLogColors.Modify,
      lines: [
        { label: 'Member', mention: userMention(targetId), value: targetId },
        reasonLine(input),
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}
