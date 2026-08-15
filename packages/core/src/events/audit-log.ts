import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';
import type { EventType } from './types.ts';

/**
 * The events the gateway derives from GUILD_AUDIT_LOG_ENTRY_CREATE.
 *
 * Every one of them requires the VIEW_AUDIT_LOG permission and the
 * GUILD_MODERATION intent (1<<2) — Discord sends the dispatch to nobody else.
 * A module listening for any of these must therefore declare VIEW_AUDIT_LOG in
 * `requiredPermissions`, so `ModuleRegistry` disables it with a reason naming
 * the permission (§7) instead of leaving it subscribed to a silent stream.
 * `requiresAuditLog` below is that check, so no module has to remember the list.
 */
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

/** Whether listening to any of these event types needs VIEW_AUDIT_LOG. */
export function requiresAuditLog(types: readonly string[]): boolean {
  return types.some(isAuditLogEventType);
}

/**
 * What an audit-derived event carries.
 *
 * Unlike the other events, this payload is *not* the raw dispatch. Consumers of
 * these events exist to answer "who did this, how often, how recently", and
 * PLAN.md P1 keeps knowledge of Discord's shapes inside the gateway normaliser —
 * so the normaliser lifts the four fields that matter out of the entry rather
 * than making every anti-nuke predicate reach into `d.user_id` itself.
 *
 * A Zod schema rather than a bare interface because the bus round-trips payloads
 * through JSON: by the time a worker sees one, the type has been erased and the
 * only thing standing between a malformed entry and a breaker decision is a
 * parse. The normaliser validates with this same schema on the way out, so there
 * is one definition of the shape and no chance of the two ends disagreeing.
 */
export const auditLogEventPayloadSchema = z.object({
  /** The audit entry's own snowflake. Stable across RESUME — hence the event id. */
  entryId: snowflakeSchema,
  guildId: snowflakeSchema,
  /** Discord's numeric action type, kept so a log line can name the raw cause. */
  actionType: z.number().int().nonnegative(),
  /**
   * Who performed it. Nullable because Discord omits `user_id` for entries with
   * no human behind them — the anti-nuke path must skip those rather than
   * inventing an actor, and the logging path still wants the event.
   */
  actorId: snowflakeSchema.nullable(),
  /**
   * What it was done to: a channel, role, webhook, emoji or user id. A plain
   * string, not a snowflake — a few audit actions target things identified by
   * code rather than id, and rejecting the whole event over the target field
   * would drop a destructive act we can still count against its actor.
   */
  targetId: z.string().min(1).max(100).nullable(),
  /** The `X-Audit-Log-Reason` header the actor supplied, if any. */
  reason: z.string().nullable(),
});

export type AuditLogEventPayload = z.infer<typeof auditLogEventPayloadSchema>;
