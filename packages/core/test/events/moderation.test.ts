import { describe, expect, test } from 'bun:test';
import {
  moderationPunishmentExpiredSchema,
  moderationReportActionRequestedSchema,
  moderationReportResolvedSchema,
  moderationReportSubmittedSchema,
  REPORT_ACTIONS,
  REPORT_METHODS,
  REPORT_STATUSES,
  reportActionOutcomeSchema,
  reportActionParamsSchema,
} from '../../src/events/moderation.ts';
import { EVENT_TYPES, isEventType, SERVICE_EMITTED_EVENT_TYPES } from '../../src/events/types.ts';

const GUILD = '900000000000000001';
const REPORTER = '100000000000000011';
const TARGET = '100000000000000010';
const MODERATOR = '100000000000000030';
const CHANNEL = '500000000000000021';
const MESSAGE = '600000000000000031';

const submitted = {
  guildId: GUILD,
  reportId: 'Xk3P9aQ',
  number: 12,
  reporterId: REPORTER,
  targetId: TARGET,
  method: 'message_menu',
  reason: 'spam',
  channelId: CHANNEL,
  messageId: MESSAGE,
  createdAt: 1_758_000_000_000,
} as const;

const resolved = {
  guildId: GUILD,
  reportId: 'Xk3P9aQ',
  number: 12,
  targetId: TARGET,
  reporterId: REPORTER,
  status: 'accepted',
  resolvedBy: MODERATOR,
  actionKind: 'ban',
  caseIds: ['Ab12Cd3'],
  resolvedAt: 1_758_000_100_000,
} as const;

const expired = {
  guildId: GUILD,
  caseId: 'Ab12Cd3',
  kind: 'timeout',
  userId: TARGET,
  endedAt: 1_758_000_200_000,
  memberPresent: false,
} as const;

const requested = {
  requestId: 'r_01J8Z0000000000000000000',
  auditId: '01J8Z0000000000000000000AA',
  guildId: GUILD,
  reportId: 'Xk3P9aQ',
  action: 'accept',
  params: { punishment: 'timeout', duration: '1h', reason: 'Spam', deleteMessage: true },
  actorId: MODERATOR,
  actorPermissions: '8',
} as const;

describe('moderation event types', () => {
  test('are declared, and only the dashboard request is published by a service', () => {
    for (const type of [
      'moderation.report_submitted',
      'moderation.report_resolved',
      'moderation.punishment_expired',
      'moderation.report_action_requested',
    ]) {
      expect(isEventType(type)).toBe(true);
    }

    expect(SERVICE_EMITTED_EVENT_TYPES.filter((type) => type.startsWith('moderation.'))).toEqual([
      'moderation.report_action_requested',
    ]);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  test('the report vocabularies are distinct and in lifecycle order', () => {
    expect(REPORT_METHODS).toEqual(['command', 'user_menu', 'message_menu', 'reaction']);
    expect(REPORT_STATUSES).toEqual(['open', 'in_review', 'accepted', 'dismissed']);
    for (const list of [REPORT_METHODS, REPORT_STATUSES, REPORT_ACTIONS]) {
      expect(new Set<string>(list).size).toBe(list.length);
    }
  });
});

describe('moderation.report_submitted', () => {
  test('accepts every method, and a report with no message or reason', () => {
    for (const method of REPORT_METHODS) {
      expect(moderationReportSubmittedSchema.safeParse({ ...submitted, method }).success).toBe(
        true,
      );
    }
    expect(
      moderationReportSubmittedSchema.safeParse({
        ...submitted,
        method: 'command',
        reason: null,
        channelId: null,
        messageId: null,
      }).success,
    ).toBe(true);
  });

  test('refuses an unknown method, a fractional number and a non-snowflake reporter', () => {
    expect(moderationReportSubmittedSchema.safeParse({ ...submitted, method: 'dm' }).success).toBe(
      false,
    );
    expect(moderationReportSubmittedSchema.safeParse({ ...submitted, number: 1.5 }).success).toBe(
      false,
    );
    expect(
      moderationReportSubmittedSchema.safeParse({ ...submitted, reporterId: 'nova' }).success,
    ).toBe(false);
  });

  test('requires the nullable keys to be present', () => {
    const { reason: _reason, ...withoutReason } = submitted;
    expect(moderationReportSubmittedSchema.safeParse(withoutReason).success).toBe(false);
  });

  test('survives a JSON round trip', () => {
    expect(moderationReportSubmittedSchema.parse(JSON.parse(JSON.stringify(submitted)))).toEqual({
      ...submitted,
    });
  });
});

describe('moderation.report_resolved', () => {
  test('accepts an accepted report with cases and a dismissed one without', () => {
    expect(moderationReportResolvedSchema.safeParse(resolved).success).toBe(true);
    expect(
      moderationReportResolvedSchema.safeParse({
        ...resolved,
        status: 'dismissed',
        actionKind: null,
        caseIds: [],
      }).success,
    ).toBe(true);
  });

  test('refuses the statuses a report can still leave', () => {
    for (const status of ['open', 'in_review']) {
      expect(moderationReportResolvedSchema.safeParse({ ...resolved, status }).success).toBe(false);
    }
  });

  test('takes a pseudo actor as the resolver, since automation resolves too', () => {
    expect(
      moderationReportResolvedSchema.safeParse({ ...resolved, resolvedBy: 'proton:moderation' })
        .success,
    ).toBe(true);
  });
});

describe('moderation.punishment_expired', () => {
  test('accepts a timeout that ended with the member gone', () => {
    expect(moderationPunishmentExpiredSchema.parse(expired)).toEqual({ ...expired });
  });

  test('refuses any kind but a timeout', () => {
    expect(moderationPunishmentExpiredSchema.safeParse({ ...expired, kind: 'ban' }).success).toBe(
      false,
    );
  });
});

describe('moderation.report_action_requested', () => {
  test('accepts every action with empty params', () => {
    for (const action of REPORT_ACTIONS) {
      expect(
        moderationReportActionRequestedSchema.safeParse({ ...requested, action, params: {} })
          .success,
      ).toBe(true);
    }
  });

  test('carries an assignment and an unassignment', () => {
    expect(reportActionParamsSchema.parse({ assigneeId: MODERATOR })).toEqual({
      assigneeId: MODERATOR,
    });
    expect(reportActionParamsSchema.parse({ assigneeId: null })).toEqual({ assigneeId: null });
    expect(reportActionParamsSchema.safeParse({ assigneeId: 'someone' }).success).toBe(false);
  });

  test('refuses a request id outside the url-safe 8 to 64 characters', () => {
    for (const requestId of ['short', 'x'.repeat(65), 'has spaces in it', 'semi:colon1']) {
      expect(
        moderationReportActionRequestedSchema.safeParse({ ...requested, requestId }).success,
      ).toBe(false);
    }
    expect(
      moderationReportActionRequestedSchema.safeParse({ ...requested, requestId: 'x'.repeat(64) })
        .success,
    ).toBe(true);
  });

  test('keeps permissions as a decimal string, never a number', () => {
    expect(
      moderationReportActionRequestedSchema.safeParse({ ...requested, actorPermissions: 8 })
        .success,
    ).toBe(false);
    expect(
      moderationReportActionRequestedSchema.safeParse({ ...requested, actorPermissions: '0x8' })
        .success,
    ).toBe(false);
    expect(BigInt(moderationReportActionRequestedSchema.parse(requested).actorPermissions)).toBe(
      8n,
    );
  });

  test('bounds the free text a dashboard can send', () => {
    expect(reportActionParamsSchema.safeParse({ reason: 'x'.repeat(512) }).success).toBe(true);
    expect(reportActionParamsSchema.safeParse({ reason: 'x'.repeat(513) }).success).toBe(false);
    expect(reportActionParamsSchema.safeParse({ duration: 'x'.repeat(17) }).success).toBe(false);
    expect(reportActionParamsSchema.safeParse({ note: 'x'.repeat(1001) }).success).toBe(false);
    expect(reportActionParamsSchema.safeParse({ reporterNote: 'x'.repeat(1001) }).success).toBe(
      false,
    );
    expect(reportActionParamsSchema.safeParse({ punishment: 'mute' }).success).toBe(false);
  });

  test('survives a JSON round trip', () => {
    expect(
      moderationReportActionRequestedSchema.parse(JSON.parse(JSON.stringify(requested))),
    ).toEqual({ ...requested, params: { ...requested.params } });
  });
});

describe('report action outcome', () => {
  test('accepts a plain answer, a confirmation request and a case', () => {
    expect(
      reportActionOutcomeSchema.safeParse({ ok: true, code: 'claimed', message: 'Claimed.' })
        .success,
    ).toBe(true);
    expect(
      reportActionOutcomeSchema.parse({
        ok: false,
        code: 'needs_confirmation',
        message: 'They were punished recently.',
        needsConfirmation: 'recent_case',
      }).needsConfirmation,
    ).toBe('recent_case');
    expect(
      reportActionOutcomeSchema.parse({
        ok: true,
        code: 'accepted',
        message: 'Accepted.',
        caseId: 'Ab12Cd3',
      }).caseId,
    ).toBe('Ab12Cd3');
  });

  test('refuses an unknown confirmation', () => {
    expect(
      reportActionOutcomeSchema.safeParse({
        ok: false,
        code: 'x',
        message: 'x',
        needsConfirmation: 'anything',
      }).success,
    ).toBe(false);
  });
});
