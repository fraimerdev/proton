import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';
import type { EventType } from './types.ts';

export const AUDIT_LOG_EVENT_TYPES = [
  'channel.created',
  'channel.deleted',
  'role.created',
  'role.deleted',
  'webhook.deleted',
  'emoji.deleted',
  'member.kicked',
  'member.banned',
  'member.unbanned',
] as const satisfies readonly EventType[];

export type AuditLogEventType = (typeof AUDIT_LOG_EVENT_TYPES)[number];

const AUDIT_LOG_EVENT_SET: ReadonlySet<string> = new Set(AUDIT_LOG_EVENT_TYPES);

export function isAuditLogEventType(type: string): type is AuditLogEventType {
  return AUDIT_LOG_EVENT_SET.has(type);
}

export function requiresAuditLog(types: readonly string[]): boolean {
  return types.some(isAuditLogEventType);
}

export const auditLogEventPayloadSchema = z.object({
  entryId: snowflakeSchema,
  guildId: snowflakeSchema,

  actionType: z.number().int().nonnegative(),

  actorId: snowflakeSchema.nullable(),

  targetId: z.string().min(1).max(100).nullable(),

  reason: z.string().nullable(),
});

export type AuditLogEventPayload = z.infer<typeof auditLogEventPayloadSchema>;

export const auditChangeSchema = z.object({
  key: z.string().max(100),
  old_value: z.unknown().optional(),
  new_value: z.unknown().optional(),
});

export type AuditChange = z.infer<typeof auditChangeSchema>;

// `changes` and `options` are the only before/after Discord gives for guild, channel, role and
// member updates. Without them an "updated" log can say that something changed but not what.
export const auditEntrySchema = auditLogEventPayloadSchema.extend({
  changes: z.array(auditChangeSchema).max(64).default([]),

  options: z.record(z.string(), z.unknown()).nullable().default(null),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

export function auditChange(entry: AuditEntry, key: string): AuditChange | undefined {
  return entry.changes.find((change) => change.key === key);
}
