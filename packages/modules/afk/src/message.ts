import { isHumanMessage, type ProtonEvent } from '@proton/core';

export interface MentionedUser {
  id: string;
  bot: boolean;
  username: string | null;
  globalName: string | null;
  nick: string | null;
}

export interface AfkMessage {
  messageId: string;
  channelId: string;
  authorId: string;
  type: number;

  isBot: boolean;
  isWebhook: boolean;

  username: string | null;
  globalName: string | null;
  nick: string | null | undefined;
  roleIds: string[] | null;

  mentions: MentionedUser[];
  at: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nickOf(member: Record<string, unknown>): string | null | undefined {
  if (member.nick === null) return null;
  return typeof member.nick === 'string' ? member.nick : undefined;
}

function rolesOf(member: Record<string, unknown> | null): string[] | null {
  const roles = member?.roles;
  if (!Array.isArray(roles)) return null;
  return roles.filter((role): role is string => typeof role === 'string');
}

function mentionsOf(value: unknown): MentionedUser[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const mentions: MentionedUser[] = [];

  for (const entry of value) {
    const user = record(entry);
    const id = str(user?.id);
    if (!user || !id || seen.has(id)) continue;

    seen.add(id);
    mentions.push({
      id,
      bot: user.bot === true,
      username: str(user.username),
      globalName: str(user.global_name),
      nick: str(record(user.member)?.nick),
    });
  }

  return mentions;
}

export function readMessage(event: ProtonEvent): AfkMessage | null {
  const d = record(event.payload);
  const author = record(d?.author);
  if (!d || !author) return null;

  const messageId = str(d.id);
  const channelId = str(d.channel_id);
  const authorId = str(author.id);
  if (!messageId || !channelId || !authorId) return null;

  const member = record(d.member);

  return {
    messageId,
    channelId,
    authorId,
    type: typeof d.type === 'number' ? d.type : 0,

    isBot: author.bot === true,
    isWebhook: typeof d.webhook_id === 'string',

    username: str(author.username),
    globalName: str(author.global_name),
    // Undefined, not null, when nick was not sent: null means "no nickname" and would keep the tag on.
    nick: member ? nickOf(member) : undefined,
    roleIds: rolesOf(member),

    mentions: mentionsOf(d.mentions),
    at: event.occurredAt,
  };
}

export function readMemberLeft(event: ProtonEvent): string | null {
  return str(record(record(event.payload)?.user)?.id);
}

export function fromHuman(message: AfkMessage): boolean {
  return !message.isBot && !message.isWebhook && isHumanMessage(message.type);
}
