import { describe, expect, test } from 'bun:test';
import {
  APPLICATION_LIFECYCLE_EVENTS,
  APPLICATION_STATUSES,
  APPLICATION_WORK_REASONS,
  applicationActionFailedSchema,
  applicationLifecycleSchema,
  applicationWorkRequestedSchema,
} from '../../src/events/applications.ts';
import { isEventType, SERVICE_EMITTED_EVENT_TYPES } from '../../src/events/types.ts';

const GUILD = '900000000000000001';
const APPLICANT = '100000000000000001';

const lifecycle = {
  guildId: GUILD,
  applicationId: '01J8Z0000000000000000000AA',
  number: 12,
  formId: 'moderator',
  formName: 'Moderator Application',
  versionId: '01J8Z0000000000000000000BB',
  applicantId: APPLICANT,
  actorId: '100000000000000002',
  revision: 3,
  status: 'accepted',
  occurredAt: 1_770_000_000_000,
} as const;

const failed = {
  guildId: GUILD,
  applicationId: '01J8Z0000000000000000000AA',
  number: 12,
  formId: 'moderator',
  formName: 'Moderator Application',
  effectId: '01J8Z0000000000000000000CC',
  kind: 'add_role',
  errorCode: 'role_hierarchy',
  revision: 3,
  occurredAt: 1_770_000_000_000,
} as const;

describe('the applications event family', () => {
  test('declares every lifecycle type, the failure and the work request', () => {
    for (const type of [
      ...APPLICATION_LIFECYCLE_EVENTS,
      'applications.action_failed',
      'applications.work_requested',
    ]) {
      expect(`${type}: ${isEventType(type)}`).toBe(`${type}: true`);
    }
  });

  test('has ten lifecycle types, none of them repeated', () => {
    expect(APPLICATION_LIFECYCLE_EVENTS).toHaveLength(10);
    expect(new Set(APPLICATION_LIFECYCLE_EVENTS).size).toBe(10);
  });

  test('only the work request is published by a service, so the rest must be in a manifest', () => {
    expect(SERVICE_EMITTED_EVENT_TYPES).toContain('applications.work_requested');
    expect(
      SERVICE_EMITTED_EVENT_TYPES.filter(
        (type) => type.startsWith('applications.') && type !== 'applications.work_requested',
      ),
    ).toEqual([]);
  });

  test('pins the statuses the transition table is written against', () => {
    expect(APPLICATION_STATUSES).toEqual([
      'draft',
      'submitted',
      'in_review',
      'needs_info',
      'waitlisted',
      'accepted',
      'rejected',
      'withdrawn',
      'expired',
    ]);
  });
});

describe('applicationLifecycleSchema', () => {
  test('survives a JSON round trip', () => {
    expect(applicationLifecycleSchema.parse(JSON.parse(JSON.stringify(lifecycle)))).toEqual({
      ...lifecycle,
    });
  });

  test('accepts Proton itself as the actor, for expiries and automatic changes', () => {
    expect(
      applicationLifecycleSchema.safeParse({ ...lifecycle, actorId: 'proton:applications' })
        .success,
    ).toBe(true);
  });

  test('carries ids and a status, never answers or notes', () => {
    const parsed = applicationLifecycleSchema.parse({
      ...lifecycle,
      answers: { why: 'I like moderating' },
      note: 'strong candidate',
    });

    expect(Object.keys(parsed).sort()).toEqual(Object.keys(lifecycle).sort());
  });

  test('refuses an unknown status, a zero reference and a non-snowflake applicant', () => {
    expect(applicationLifecycleSchema.safeParse({ ...lifecycle, status: 'lost' }).success).toBe(
      false,
    );
    expect(applicationLifecycleSchema.safeParse({ ...lifecycle, number: 0 }).success).toBe(false);
    expect(
      applicationLifecycleSchema.safeParse({ ...lifecycle, applicantId: 'someone' }).success,
    ).toBe(false);
  });

  test.each([...APPLICATION_STATUSES])('accepts the %s status', (status) => {
    expect(applicationLifecycleSchema.safeParse({ ...lifecycle, status }).success).toBe(true);
  });
});

describe('applicationActionFailedSchema', () => {
  test('survives a JSON round trip', () => {
    expect(applicationActionFailedSchema.parse(JSON.parse(JSON.stringify(failed)))).toEqual({
      ...failed,
    });
  });

  test('refuses an error code longer than the column that stores it', () => {
    expect(
      applicationActionFailedSchema.safeParse({ ...failed, errorCode: 'x'.repeat(65) }).success,
    ).toBe(false);
  });
});

describe('applicationWorkRequestedSchema', () => {
  test('asks for one application or for the whole server', () => {
    expect(
      applicationWorkRequestedSchema.safeParse({
        guildId: GUILD,
        applicationId: '01J8Z0000000000000000000AA',
        reason: 'decision',
      }).success,
    ).toBe(true);
    expect(
      applicationWorkRequestedSchema.safeParse({ guildId: GUILD, reason: 'retry' }).success,
    ).toBe(true);
  });

  test.each([...APPLICATION_WORK_REASONS])('accepts the %s reason', (reason) => {
    expect(applicationWorkRequestedSchema.safeParse({ guildId: GUILD, reason }).success).toBe(true);
  });

  test('refuses a reason nobody handles', () => {
    expect(
      applicationWorkRequestedSchema.safeParse({ guildId: GUILD, reason: 'poke' }).success,
    ).toBe(false);
  });
});
