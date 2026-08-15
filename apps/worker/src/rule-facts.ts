import {
  auditLogEventPayloadSchema,
  isAuditLogEventType,
  type ProtonEvent,
  type RuleFacts,
  snowflakeSchema,
} from '@proton/core';
import { z } from 'zod';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nested(value: unknown, key: string): unknown {
  return record(value)?.[key];
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function messageFacts(payload: unknown): RuleFacts {
  const d = record(payload);
  if (!d) return {};

  const facts: RuleFacts = {};
  const authorId = str(nested(d.author, 'id'));
  if (authorId) facts.actorId = authorId;

  const channelId = str(d.channel_id);
  if (channelId) facts.channelId = channelId;

  const content = str(d.content);
  if (content !== undefined) facts.content = content;

  const roleIds = stringArray(nested(d.member, 'roles'));
  if (roleIds) facts.roleIds = roleIds;

  return facts;
}

function memberFacts(payload: unknown): RuleFacts {
  const d = record(payload);
  if (!d) return {};

  const facts: RuleFacts = {};
  const userId = str(nested(d.user, 'id'));
  if (userId) facts.actorId = userId;

  const roleIds = stringArray(d.roles);
  if (roleIds) facts.roleIds = roleIds;

  return facts;
}

function auditFacts(payload: unknown): RuleFacts {
  const parsed = auditLogEventPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.actorId === null) return {};
  return { actorId: parsed.data.actorId };
}

export const internalMemberEventSchema = z.object({
  userId: snowflakeSchema,

  channelId: snowflakeSchema.optional(),
});

function internalMemberFacts(payload: unknown): RuleFacts {
  const parsed = internalMemberEventSchema.safeParse(payload);
  if (!parsed.success) return {};

  return {
    actorId: parsed.data.userId,
    ...(parsed.data.channelId ? { channelId: parsed.data.channelId } : {}),
  };
}

export function factsFor(event: ProtonEvent): RuleFacts {
  if (isAuditLogEventType(event.type)) return auditFacts(event.payload);

  switch (event.type) {
    case 'message.created':
    case 'message.updated':
      return messageFacts(event.payload);

    case 'member.joined':
    case 'member.left':
    case 'member.updated':
      return memberFacts(event.payload);

    case 'moderation.warned':
    case 'xp.level_gained':
      return internalMemberFacts(event.payload);

    default:
      return {};
  }
}
