import { describe, expect, test } from 'bun:test';
import {
  automationRunQuerySchema,
  caseEvidenceViewSchema,
  REPORT_PAGE_SIZE_DEFAULT,
  reportActionBodySchema,
  reportDetailSchema,
  reportListResultSchema,
  reportQuerySchema,
  reportSummaryCountsSchema,
  reportSummarySchema,
} from '../src/reports/view.ts';
import { GUILD, MEMBER, MODERATOR, REPORTER } from './harness.ts';
import { MemoryReportStore } from './reports-memory-store.ts';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

async function stored() {
  const store = new MemoryReportStore(() => NOW);
  const result = await store.submit(
    {
      guildId: GUILD,
      reporterId: REPORTER,
      targetId: MEMBER,
      method: 'message_menu',
      reasonId: 'spam',
      reason: 'Spam or flooding',
      customReason: null,
      comment: 'details',
      source: {
        channelId: '500000000000000001',
        messageId: '1400000000000000001',
        authorId: MEMBER,
      },
      evidence: {
        links: [{ url: 'https://discord.com/channels/1/2/3', status: 'other_server' }],
        attachments: [],
      },
      idempotencyKey: 'interaction:1',
      now: NOW,
    },
    {
      cooldownMs: 0,
      bypassCooldown: false,
      duplicateProtection: true,
      maxOpenPerMember: 10,
      maxOpenPerServer: 100,
    },
  );
  if (result.status !== 'filed') throw new Error('not filed');
  return { store, report: result.report };
}

describe('reportQuerySchema', () => {
  test('defaults to the active queue, newest first, 25 a page', () => {
    expect(reportQuerySchema.parse({})).toEqual({
      status: 'active',
      sort: 'created',
      dir: 'desc',
      page: 1,
      pageSize: REPORT_PAGE_SIZE_DEFAULT,
    });
  });

  test('coerces query-string numbers and drops empty values', () => {
    const query = reportQuerySchema.parse({
      page: '3',
      pageSize: '10',
      q: '',
      targetId: '',
      assigneeId: 'none',
      status: 'resolved',
    });

    expect(query).toMatchObject({ page: 3, pageSize: 10, assigneeId: 'none', status: 'resolved' });
    expect(query.q).toBeUndefined();
    expect(query.targetId).toBeUndefined();
  });

  test('refuses pages over 30, unknown statuses and a reversed range', () => {
    expect(reportQuerySchema.safeParse({ pageSize: '31' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ status: 'closed' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ assigneeId: 'someone' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: '2026-09-18', to: '2026-09-01' }).success).toBe(
      false,
    );
    expect(
      reportQuerySchema.safeParse({ from: '2026-09-01', to: '2026-09-18T10:00:00Z' }).success,
    ).toBe(true);
  });

  test('sorting by volume needs the member grouping', () => {
    expect(reportQuerySchema.safeParse({ sort: 'volume' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ sort: 'volume', group: 'member' }).success).toBe(true);
  });
});

describe('result schemas', () => {
  test('a stored report parses as a summary and, with its extras, as a detail', async () => {
    const { store, report } = await stored();

    const summary = reportSummarySchema.parse(report);
    expect(summary).not.toHaveProperty('comment');
    expect(summary).not.toHaveProperty('evidence');

    const detail = reportDetailSchema.parse({
      ...report,
      deciding: false,
      events: await store.listEvents(GUILD, report.id),
      related: [],
      cases: [],
      stats: await store.targetStats(GUILD, MEMBER, 0),
    });
    expect(detail).not.toHaveProperty('idempotencyKey');
    expect(detail).not.toHaveProperty('decision');
    expect(detail.evidence.links[0]?.status).toBe('other_server');

    expect(
      reportListResultSchema.parse({
        grouped: false,
        reports: [summary],
        total: 1,
        page: 1,
        pageSize: 25,
      }),
    ).toMatchObject({ grouped: false });
    expect(
      reportListResultSchema.parse({
        grouped: true,
        groups: [
          {
            targetId: MEMBER,
            total: 1,
            open: 1,
            distinctReporters: 1,
            firstAt: NOW,
            lastAt: NOW,
            reports: [summary],
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      }),
    ).toMatchObject({ grouped: true });
  });

  test('summary counts, runs and case evidence', () => {
    expect(
      reportSummaryCountsSchema.safeParse({
        counts: { open: 3, in_review: 1, accepted: 0, dismissed: 2 },
        openUnclaimed: 2,
        oldestOpenAt: NOW,
        deliveryProblems: 0,
        closeProblems: 0,
        automationFailures7d: 1,
      }).success,
    ).toBe(true);

    expect(automationRunQuerySchema.parse({ status: '', page: '2' })).toEqual({
      page: 2,
      pageSize: REPORT_PAGE_SIZE_DEFAULT,
    });

    expect(caseEvidenceViewSchema.parse({ proof: null, history: [] })).toEqual({
      proof: null,
      history: [],
    });
  });
});

describe('reportActionBodySchema', () => {
  const body = {
    action: 'accept',
    params: { punishment: 'ban', reason: 'spam' },
    requestId: 'req_12345678',
    actorId: MODERATOR,
    actorPermissions: '32',
    source: 'dashboard',
  };

  test('accepts a dashboard action and defaults empty params', () => {
    expect(reportActionBodySchema.parse(body).params).toEqual({
      punishment: 'ban',
      reason: 'spam',
    });
    expect(
      reportActionBodySchema.parse({ ...body, action: 'claim', params: undefined }).params,
    ).toEqual({});
  });

  test('refuses short request ids, non-numeric permissions and other sources', () => {
    expect(reportActionBodySchema.safeParse({ ...body, requestId: 'short' }).success).toBe(false);
    expect(reportActionBodySchema.safeParse({ ...body, actorPermissions: 'all' }).success).toBe(
      false,
    );
    expect(reportActionBodySchema.safeParse({ ...body, source: 'discord' }).success).toBe(false);
    expect(reportActionBodySchema.safeParse({ ...body, action: 'reopen' }).success).toBe(false);
  });
});
