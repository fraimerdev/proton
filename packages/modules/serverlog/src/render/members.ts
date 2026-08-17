import { snowflakeCreatedAt } from '@proton/core';
import { ServerLogColors } from '../colours.ts';
import { type LogLine, logEmbed, timestampLine, userMention } from '../embed.ts';
import { changeOf, type RenderInput, type RenderResult, record, str } from './types.ts';

interface MemberSubject {
  id: string;
  username: string;
  bot: boolean;
}

function memberOf(input: RenderInput): MemberSubject | null {
  const payload = record(input.entity);
  const user = record(payload?.user);

  const id = str(user?.id) ?? input.audit?.targetId ?? undefined;
  if (!id) return null;

  return {
    id,
    username: str(user?.username) ?? id,
    bot: user?.bot === true,
  };
}

function accountAgeLine(userId: string): LogLine {
  const created = snowflakeCreatedAt(userId);

  return created === null
    ? { label: 'Account created', value: 'unknown' }
    : { label: 'Account created', mention: timestampLine(created / 1000) };
}

export function renderMemberJoined(input: RenderInput): RenderResult | null {
  const member = memberOf(input);
  if (!member) return null;

  return {
    embed: logEmbed({
      subject: member.bot ? 'Bot' : 'Member',
      action: 'joined',
      colour: ServerLogColors.Add,
      lines: [
        { label: 'Member', mention: userMention(member.id), value: `@${member.username}` },
        { label: 'Id', value: member.id },
        accountAgeLine(member.id),
      ],
      executor: null,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderMemberLeft(input: RenderInput): RenderResult | null {
  const member = memberOf(input);
  if (!member) return null;

  return {
    embed: logEmbed({
      subject: member.bot ? 'Bot' : 'Member',
      action: 'left',
      colour: ServerLogColors.Remove,
      lines: [
        { label: 'Member', mention: userMention(member.id), value: `@${member.username}` },
        { label: 'Id', value: member.id },
      ],
      executor: null,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderScreeningPassed(input: RenderInput): RenderResult | null {
  const member = memberOf(input);
  if (!member) return null;

  return {
    embed: logEmbed({
      subject: 'Member',
      action: 'accepted the rules',
      colour: ServerLogColors.Modify,
      lines: [
        { label: 'Member', mention: userMention(member.id), value: `@${member.username}` },
        { label: 'Id', value: member.id },
      ],
      executor: null,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderNicknameChanged(input: RenderInput): RenderResult | null {
  const targetId = input.audit?.targetId;
  if (!targetId) return null;

  const { before, after } = changeOf(input.audit, 'nick');
  if (before === undefined && after === undefined) return null;

  return {
    embed: logEmbed({
      subject: 'Nickname',
      action: 'changed',
      colour: ServerLogColors.Modify,
      lines: [
        { label: 'Member', mention: userMention(targetId), value: targetId },
        { label: 'Before', value: before ?? 'none' },
        { label: 'After', value: after ?? 'none' },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

function roleIdsFrom(input: RenderInput, key: '$add' | '$remove'): string[] {
  const change = input.audit?.changes.find((candidate) => candidate.key === key);
  const value = change?.new_value ?? change?.old_value;
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => str(record(entry)?.id))
    .filter((id): id is string => typeof id === 'string');
}

function rolesEmbed(
  input: RenderInput,
  key: '$add' | '$remove',
  action: 'added' | 'removed',
  colour: number,
): RenderResult | null {
  const targetId = input.audit?.targetId;
  const roleIds = roleIdsFrom(input, key);
  if (!targetId || roleIds.length === 0) return null;

  return {
    embed: logEmbed({
      subject: roleIds.length === 1 ? 'Role' : 'Roles',
      action,
      colour,
      lines: [
        { label: 'Member', mention: userMention(targetId), value: targetId },
        {
          label: roleIds.length === 1 ? 'Role' : 'Roles',
          mention: roleIds.map((id) => `<@&${id}>`).join(' '),
        },
      ],
      executor: input.executor,
      occurredAt: input.occurredAt,
      emojis: input.emojis,
    }),
  };
}

export function renderRolesAdded(input: RenderInput): RenderResult | null {
  return rolesEmbed(input, '$add', 'added', ServerLogColors.Add);
}

export function renderRolesRemoved(input: RenderInput): RenderResult | null {
  return rolesEmbed(input, '$remove', 'removed', ServerLogColors.Remove);
}
