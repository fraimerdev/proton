import { describe, expect, test } from 'bun:test';
import { joinrolesSyncRequestedSchema } from '../../src/events/joinroles.ts';
import { isEventType, SERVICE_EMITTED_EVENT_TYPES } from '../../src/events/types.ts';

const payload = {
  auditId: '01J8Z0000000000000000000AA',
  guildId: '900000000000000001',
  runId: '01J8Z0000000000000000000BB',
  kind: 'sync',
  actorId: '100000000000000001',
} as const;

describe('joinroles.sync_requested', () => {
  test('is a declared event type the api publishes, not a module', () => {
    expect(isEventType('joinroles.sync_requested')).toBe(true);
    expect(SERVICE_EMITTED_EVENT_TYPES).toContain('joinroles.sync_requested');
  });

  test('accepts a sync and a count', () => {
    expect(joinrolesSyncRequestedSchema.safeParse(payload).success).toBe(true);
    expect(joinrolesSyncRequestedSchema.safeParse({ ...payload, kind: 'count' }).success).toBe(
      true,
    );
  });

  test('refuses an unknown kind, a non-snowflake actor and an oversized run id', () => {
    expect(joinrolesSyncRequestedSchema.safeParse({ ...payload, kind: 'purge' }).success).toBe(
      false,
    );
    expect(
      joinrolesSyncRequestedSchema.safeParse({ ...payload, actorId: 'proton:joinroles' }).success,
    ).toBe(false);
    expect(
      joinrolesSyncRequestedSchema.safeParse({ ...payload, runId: 'x'.repeat(65) }).success,
    ).toBe(false);
  });

  test('survives a JSON round trip', () => {
    expect(joinrolesSyncRequestedSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual({
      ...payload,
    });
  });
});
