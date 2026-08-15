import { describe, expect, test } from 'bun:test';
import {
  AUDIT_LOG_EVENT_TYPES,
  type AuditLogEventPayload,
  auditLogEventPayloadSchema,
  isAuditLogEventType,
  requiresAuditLog,
} from '../../src/events/audit-log.ts';
import { isEventType } from '../../src/events/types.ts';

const payload: AuditLogEventPayload = {
  entryId: '1537750759112835075',
  guildId: '900000000000000001',
  actionType: 12,
  actorId: '200000000000000009',
  targetId: '500000000000000042',
  reason: 'spring cleaning',
};

describe('audit log event types', () => {
  test('every one of them is a real event type', () => {
    expect(AUDIT_LOG_EVENT_TYPES.filter((type) => !isEventType(type))).toEqual([]);
  });

  test('recognises its own members and nothing else', () => {
    expect(isAuditLogEventType('channel.deleted')).toBe(true);
    expect(isAuditLogEventType('message.created')).toBe(false);
  });

  /**
   * The §7 hook. A module listening for any audit-derived event must declare
   * VIEW_AUDIT_LOG, or Discord sends it an empty stream and it reports a quiet
   * guild — the "the bot did nothing" failure the registry exists to prevent.
   * Asking here means no module author has to memorise the list.
   */
  test('flags a listener set that needs VIEW_AUDIT_LOG', () => {
    expect(requiresAuditLog(['message.created', 'channel.deleted'])).toBe(true);
    expect(requiresAuditLog(['message.created', 'member.joined'])).toBe(false);
    expect(requiresAuditLog([])).toBe(false);
  });
});

describe('audit log payload schema', () => {
  /**
   * The reason the payload is a schema and not a bare interface: the bus
   * JSON-serialises every event, so by the time a worker reads one the type is
   * gone and a parse is all that stands between a malformed entry and a breaker
   * decision.
   */
  test('survives the bus round-trip intact', () => {
    const parsed = auditLogEventPayloadSchema.safeParse(JSON.parse(JSON.stringify(payload)));

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(payload);
  });

  test('accepts an entry Discord attributed to nobody', () => {
    expect(auditLogEventPayloadSchema.safeParse({ ...payload, actorId: null }).success).toBe(true);
  });

  test('rejects an entry with no usable guild or entry id', () => {
    expect(auditLogEventPayloadSchema.safeParse({ ...payload, guildId: 'nope' }).success).toBe(
      false,
    );
    expect(auditLogEventPayloadSchema.safeParse({ ...payload, entryId: null }).success).toBe(false);
  });

  /**
   * Not every audit action identifies its target by snowflake, and dropping a
   * destructive act over its target field would lose the actor we can still
   * count. So the target is permissive where the actor is not.
   */
  test('accepts a non-snowflake target but not a non-snowflake actor', () => {
    expect(auditLogEventPayloadSchema.safeParse({ ...payload, targetId: 'aBc123' }).success).toBe(
      true,
    );
    expect(auditLogEventPayloadSchema.safeParse({ ...payload, actorId: 'aBc123' }).success).toBe(
      false,
    );
  });
});
