import { describe, expect, test } from 'bun:test';
import {
  automationRunListSchema,
  caseEvidenceViewSchema,
  type ReportQueryInput,
  reportDetailSchema,
  reportListResultSchema,
  reportSummaryCountsSchema,
} from '@proton/module-moderation/reports-view';
import {
  automationRunSearchSchema,
  ReportsError,
  ReportsService,
  reportSearchSchema,
} from '../src/moderation/reports.ts';
import { type FakeQuery, fakePostgres, pick } from './fake-postgres.ts';
import {
  ADMIN,
  CHANNEL,
  COMMENT,
  GUILD,
  iso,
  MESSAGE,
  MODERATOR,
  NOW,
  OTHER_TARGET,
  REPORTER,
  type Row,
  reportRow,
  SECOND_REPORTER,
  SNAPSHOT_TEXT,
  TARGET,
} from './report-rows.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;

type Answer = [string | RegExp, (query: FakeQuery) => unknown[][]];

function rig(answers: Answer[] = []) {
  const { handle, queries } = fakePostgres((query) => {
    for (const [match, answer] of answers) {
      if (typeof match === 'string' ? query.sql.includes(match) : match.test(query.sql)) {
        return answer(query);
      }
    }
    return [];
  });

  const service = new ReportsService({
    db: handle,
    modules: {
      get: () => Promise.reject(new Error('reads never ask for the module config')),
    },
    audit: () => Promise.reject(new Error('reads never audit')),
    now: () => NOW,
  });

  return { service, queries };
}

function search(
  service: ReportsService,
  input: ReportQueryInput & { close?: string } = {},
  viewerId?: string,
) {
  return service.search(GUILD, reportSearchSchema.parse(input), viewerId);
}

function only(queries: FakeQuery[], fragment: string): FakeQuery {
  const matched = queries.filter((query) => query.sql.includes(fragment));
  expect(matched).toHaveLength(1);
  return matched[0] as FakeQuery;
}

const LIST = 'from "reports" where';
const COUNT = 'select count(*) from "reports"';
const LOOKUP = '"reports"."id" = $2) limit';

const rowsOf = (rows: Row[]) => (query: FakeQuery) => rows.map((row) => pick(query, row));

describe('the queue', () => {
  test('reads the summary columns only, never evidence, comments or decision tokens', async () => {
    const { service, queries } = rig();

    await search(service);

    const list = queries[0]?.sql ?? '';
    for (const column of [
      '"evidence"',
      '"comment"',
      '"reporter_note"',
      '"resolution_note"',
      '"decision_token"',
      '"idempotency_key"',
      '"dm_channel_id"',
      '"notifications"',
    ]) {
      expect(list).not.toContain(column);
    }
    expect(list).toContain('"custom_reason"');
  });

  test('shows active reports newest first by default, the number breaking ties', async () => {
    const { service, queries } = rig();

    await search(service);

    const [list] = queries;
    expect(list?.sql).toContain('"reports"."guild_id" = $1 and "reports"."status" in ($2, $3)');
    expect(list?.sql).toContain('order by "reports"."created_at" desc, "reports"."number" desc');
    expect(list?.sql).toContain('limit $4');
    expect(list?.sql).not.toContain('offset');
    expect(list?.params).toEqual([GUILD, 'open', 'in_review', 25]);
  });

  test('resolved, a single status and all map to their filters', async () => {
    const { service, queries } = rig();

    await search(service, { status: 'resolved' });
    await search(service, { status: 'in_review' });
    await search(service, { status: 'all' });

    expect(queries[0]?.params.slice(1, 3)).toEqual(['accepted', 'dismissed']);
    expect(queries[2]?.sql).toContain('"reports"."status" = $2');
    expect(queries[2]?.params[1]).toBe('in_review');
    expect(queries[4]?.sql).not.toContain('"status" in');
    expect(queries[4]?.sql).not.toContain('"reports"."status" =');
  });

  test('member, reporter, assignee, date and delivery filters', async () => {
    const { service, queries } = rig();

    await search(service, {
      status: 'all',
      targetId: TARGET,
      reporterId: REPORTER,
      assigneeId: MODERATOR,
      from: '2026-09-01',
      to: '2026-09-18',
      delivery: 'problem',
    });

    const [list] = queries;
    expect(list?.sql).toContain(
      '"reports"."target_id" = $2 and "reports"."reporter_id" = $3 and ' +
        '"reports"."assignee_id" = $4 and "reports"."created_at" >= $5 and ' +
        '"reports"."created_at" <= $6 and "reports"."card_state" in ($7, $8)',
    );
    expect(list?.params.slice(0, 8)).toEqual([
      GUILD,
      TARGET,
      REPORTER,
      MODERATOR,
      '2026-09-01T00:00:00.000Z',
      '2026-09-18T23:59:59.999Z',
      'failed',
      'missing',
    ]);
  });

  test('close problems are decided reports whose card was never closed', async () => {
    const { service, queries } = rig();

    await search(service, { status: 'all', close: 'problem' });

    expect(queries[0]?.sql).toContain(
      '"reports"."guild_id" = $1 and ("reports"."close_error" is not null and ' +
        '"reports"."closed_at" is null)',
    );
  });

  test('unassigned means no assignee, and a datetime range is taken as given', async () => {
    const { service, queries } = rig();

    await search(service, {
      assigneeId: 'none',
      from: '2026-09-01T08:30:00.000Z',
      to: '2026-09-01T11:30:00+02:00',
    });

    expect(queries[0]?.sql).toContain('"reports"."assignee_id" is null');
    expect(queries[0]?.params).toContain('2026-09-01T08:30:00.000Z');
    expect(queries[0]?.params).toContain('2026-09-01T09:30:00.000Z');
  });

  test('a search finds a #number, a member id, or part of a report id', async () => {
    const { service, queries } = rig();

    await search(service, { status: 'all', q: '#12' });
    await search(service, { status: 'all', q: TARGET });
    await search(service, { status: 'all', q: '12' });
    await search(service, { status: 'all', q: 'Xk3' });

    expect(queries[0]?.sql).toContain('"reports"."number" = $2');
    expect(queries[0]?.params[1]).toBe(12);

    expect(queries[2]?.sql).toContain(
      '("reports"."target_id" = $2 or "reports"."reporter_id" = $3)',
    );
    expect(queries[2]?.params.slice(1, 3)).toEqual([TARGET, TARGET]);

    expect(queries[4]?.sql).toContain(
      `("reports"."number" = $2 or "reports"."id" ilike $3 escape '\\')`,
    );
    expect(queries[4]?.params.slice(1, 3)).toEqual([12, '%12%']);

    expect(queries[6]?.sql).toContain(`"reports"."id" ilike $2 escape '\\'`);
    expect(queries[6]?.params[1]).toBe('%Xk3%');
  });

  test('a search escapes LIKE wildcards', async () => {
    const { service, queries } = rig();

    await search(service, { status: 'all', q: 'a_b%c\\' });

    expect(queries[0]?.params[1]).toBe('%a\\_b\\%c\\\\%');
  });

  test('sorting by number uses it alone; later pages skip the earlier ones', async () => {
    const { service, queries } = rig();

    await search(service, { sort: 'number', dir: 'asc', page: 3, pageSize: 10 });

    expect(queries[0]?.sql).toContain('order by "reports"."number" asc limit $4 offset $5');
    expect(queries[0]?.params.slice(3)).toEqual([10, 20]);
  });

  test('the same filter counts the total', async () => {
    const { service, queries } = rig([[COUNT, () => [['41']]]]);

    const result = await search(service, { q: '#3' });

    const count = only(queries, COUNT);
    expect(count.sql).toContain('"reports"."number" = $4');
    expect(result.total).toBe(41);
  });

  test('maps rows to summaries with epoch times and nested card and close state', async () => {
    const claimed = reportRow({
      status: 'in_review',
      assignee_id: MODERATOR,
      assigned_at: iso(NOW - 5 * MINUTE),
      card_state: 'failed',
      card_error: 'I need Send Messages in #reports to post the report.',
      close_action: 'move',
      close_due_at: iso(NOW + DAY),
    });
    const { service } = rig([
      [COUNT, () => [['1']]],
      [LIST, rowsOf([claimed])],
    ]);

    const result = reportListResultSchema.parse(await search(service));

    expect(result).toEqual({
      grouped: false,
      reports: [
        {
          id: 'Xk3P9aQ',
          number: 7,
          status: 'in_review',
          method: 'message_menu',
          reporterId: REPORTER,
          targetId: TARGET,
          reasonId: 'scam',
          reason: 'Scam or suspicious link',
          customReason: null,
          sourceChannelId: CHANNEL,
          sourceMessageId: MESSAGE,
          assigneeId: MODERATOR,
          assignedAt: NOW - 5 * MINUTE,
          resolvedBy: null,
          resolvedAt: null,
          actionKind: null,
          caseIds: [],
          card: {
            channelId: '500000000000000002',
            messageId: '600000000000000002',
            evidenceMessageId: null,
            state: 'failed',
            error: 'I need Send Messages in #reports to post the report.',
            attempts: 1,
            version: 1,
          },
          close: { action: 'move', dueAt: NOW + DAY, closedAt: null, attempts: 0, error: null },
          evidencePurgedAt: null,
          createdAt: NOW - 60 * MINUTE,
          updatedAt: NOW - 30 * MINUTE,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });
  });
});

describe('reports about the viewer', () => {
  const VIEWER = MODERATOR;

  test('the queue never lists them, flat or grouped, and counts without them', async () => {
    const { service, queries } = rig();

    await search(service, {}, VIEWER);
    await search(service, { group: 'member', sort: 'volume' }, VIEWER);

    const [list, total] = queries;
    expect(list?.sql).toContain('"reports"."status" in ($2, $3) and "reports"."target_id" <> $4');
    expect(list?.params.slice(0, 4)).toEqual([GUILD, 'open', 'in_review', VIEWER]);
    expect(total?.sql).toContain('"reports"."target_id" <> $4');

    const grouped = only(queries, 'select "target_id", count(*)');
    expect(grouped.sql).toContain('"reports"."target_id" <> $');
    expect(grouped.params).toContain(VIEWER);
  });

  test('a search by the viewer’s own id finds nothing about them', async () => {
    const { service, queries } = rig();

    await search(service, { status: 'all', q: VIEWER }, VIEWER);

    expect(queries[0]?.sql).toContain(
      '("reports"."target_id" = $2 or "reports"."reporter_id" = $3) and ' +
        '"reports"."target_id" <> $4',
    );
  });

  test('without a viewer nothing is excluded', async () => {
    const { service, queries } = rig();

    await search(service);

    expect(queries[0]?.sql).not.toContain('<>');
  });

  test('the summary leaves out their reports and the automation runs about them', async () => {
    const { service, queries } = rig();

    await service.summary(GUILD, VIEWER);

    const counts = only(queries, 'count(*) filter (where "reports"."status" = $1)');
    expect(counts.sql).toMatch(/"reports"\."guild_id" = \$\d+ and "reports"\."target_id" <> \$\d+/);
    expect(counts.params.at(-1)).toBe(VIEWER);

    const runs = only(queries, 'from "report_automation_runs"');
    expect(runs.sql).toContain('"report_automation_runs"."target_id" <> $5');
    expect(runs.params).toEqual([GUILD, 'failed', 'partial', iso(NOW - 7 * DAY), VIEWER]);
  });

  test('a report about them is not found, with nothing else read', async () => {
    const { service, queries } = rig([
      [LOOKUP, (query) => [pick(query, reportRow({ target_id: VIEWER }))]],
    ]);

    await expect(service.detail(GUILD, 'Xk3P9aQ', VIEWER)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(queries).toHaveLength(1);
  });

  test('a report they filed is still theirs to read', async () => {
    const { service } = rig([
      [LOOKUP, (query) => [pick(query, reportRow({ reporter_id: VIEWER }))]],
    ]);

    expect((await service.detail(GUILD, 'Xk3P9aQ', VIEWER)).reporterId).toBe(VIEWER);
  });

  test('automation runs about them are left out', async () => {
    const { service, queries } = rig();

    await service.automationRuns(GUILD, automationRunSearchSchema.parse({}), VIEWER);

    expect(queries[0]?.sql).toContain(
      '"report_automation_runs"."guild_id" = $1 and "report_automation_runs"."target_id" <> $2',
    );
    expect(queries[0]?.params.slice(0, 2)).toEqual([GUILD, VIEWER]);
  });
});

describe('the queue grouped by member', () => {
  const GROUPS = 'select "target_id", count(*)';

  test('ranks members by volume, then latest report, then id', async () => {
    const { service, queries } = rig();

    await search(service, { group: 'member', sort: 'volume' });

    const groups = only(queries, GROUPS);
    expect(groups.sql).toContain(
      'count(*), count(*) filter (where "reports"."status" in ($1, $2)), ' +
        'count(distinct "reporter_id"), min("created_at"), max("created_at") from "reports"',
    );
    expect(groups.sql).toContain(
      'group by "reports"."target_id" order by count(*) desc, max("reports"."created_at") desc, ' +
        '"reports"."target_id" asc limit $6',
    );
  });

  test('created and number sort by each member’s latest report', async () => {
    const { service, queries } = rig();

    await search(service, { group: 'member' });
    await search(service, { group: 'member', sort: 'number', dir: 'asc' });

    const [created, numbered] = queries.filter((query) => query.sql.startsWith(GROUPS));
    expect(created?.sql).toContain(
      'order by max("reports"."created_at") desc, "reports"."target_id" asc',
    );
    expect(numbered?.sql).toContain(
      'order by max("reports"."number") asc, "reports"."target_id" asc',
    );
  });

  test('counts members, not reports, and skips the preview when nobody matched', async () => {
    const { service, queries } = rig([['count(distinct "target_id")', () => [['0']]]]);

    const result = await search(service, { group: 'member' });

    expect(result).toEqual({ grouped: true, groups: [], total: 0, page: 1, pageSize: 25 });
    expect(queries.some((query) => query.sql.includes('row_number()'))).toBe(false);
  });

  test('each group carries its five newest matching reports', async () => {
    const newest = reportRow({ id: 'Aaaaaaa', number: 9, reporter_id: SECOND_REPORTER });
    const older = reportRow({ id: 'Bbbbbbb', number: 8, created_at: iso(NOW - 3 * 60 * MINUTE) });
    const other = reportRow({ id: 'Ccccccc', number: 6, target_id: OTHER_TARGET });

    const { service, queries } = rig([
      [
        GROUPS,
        () => [
          [TARGET, '2', '2', '2', iso(NOW - 3 * 60 * MINUTE), iso(NOW - 60 * MINUTE)],
          [OTHER_TARGET, '1', '1', '1', iso(NOW - 60 * MINUTE), iso(NOW - 60 * MINUTE)],
        ],
      ],
      ['count(distinct "target_id")', () => [['2']]],
      [
        'row_number()',
        (query) => [newest, other, older].map((row) => pick(query, { ...row, rank: 1 })),
      ],
    ]);

    const result = reportListResultSchema.parse(
      await search(service, { group: 'member', sort: 'volume' }),
    );

    const preview = only(queries, 'row_number()');
    expect(preview.sql).toContain(
      'row_number() over (partition by "target_id" order by "created_at" desc, "number" desc) as "rank"',
    );
    expect(preview.sql).toContain('"reports"."target_id" in ($4, $5)');
    expect(preview.sql).toContain('"ranked" where "rank" <= $6');
    expect(preview.params.slice(3)).toEqual([TARGET, OTHER_TARGET, 5]);

    if (!result.grouped) throw new Error('expected groups');
    expect(result.total).toBe(2);
    expect(
      result.groups.map((group) => ({ ...group, reports: group.reports.map((r) => r.id) })),
    ).toEqual([
      {
        targetId: TARGET,
        total: 2,
        open: 2,
        distinctReporters: 2,
        firstAt: NOW - 3 * 60 * MINUTE,
        lastAt: NOW - 60 * MINUTE,
        reports: ['Aaaaaaa', 'Bbbbbbb'],
      },
      {
        targetId: OTHER_TARGET,
        total: 1,
        open: 1,
        distinctReporters: 1,
        firstAt: NOW - 60 * MINUTE,
        lastAt: NOW - 60 * MINUTE,
        reports: ['Ccccccc'],
      },
    ]);
  });
});

describe('the summary', () => {
  test('counts statuses, waiting reports and problems, and automation failures over 7 days', async () => {
    const { service, queries } = rig([
      [
        'count(*) filter (where "reports"."status" = $1)',
        () => [['3', '1', '12', '4', '2', iso(NOW - 2 * 60 * MINUTE), '1', '1']],
      ],
      ['from "report_automation_runs"', () => [['2']]],
    ]);

    const summary = reportSummaryCountsSchema.parse(await service.summary(GUILD));

    expect(summary).toEqual({
      counts: { open: 3, in_review: 1, accepted: 12, dismissed: 4 },
      openUnclaimed: 2,
      oldestOpenAt: NOW - 2 * 60 * MINUTE,
      deliveryProblems: 1,
      closeProblems: 1,
      automationFailures7d: 2,
    });

    const runs = only(queries, 'from "report_automation_runs"');
    expect(runs.sql).toContain('"report_automation_runs"."status" in ($2, $3)');
    expect(runs.params).toEqual([GUILD, 'failed', 'partial', iso(NOW - 7 * DAY)]);
  });

  test('an empty server has no oldest open report', async () => {
    const { service } = rig([
      [
        'count(*) filter (where "reports"."status" = $1)',
        () => [['0', '0', '0', '0', '0', null, '0', '0']],
      ],
    ]);

    const summary = await service.summary(GUILD);

    expect(summary.oldestOpenAt).toBeNull();
    expect(summary.automationFailures7d).toBe(0);
  });
});

describe('a report in detail', () => {
  const EVENTS = 'from "report_events"';
  const RELATED = '"reports"."id" <> $3';
  const CASES = 'from "cases"';
  const STATS = 'select count(*) filter (where "reports"."created_at" >= $1)';

  function detailRig(row: Row, extra: Answer[] = []) {
    return rig([
      [LOOKUP, (query) => (query.params[1] === row.id ? [pick(query, row)] : [])],
      ...extra,
    ]);
  }

  test('404 not_found for an id this server does not have', async () => {
    const { service } = detailRig(reportRow());

    await expect(service.detail(GUILD, 'Nope000')).rejects.toBeInstanceOf(ReportsError);
    await expect(service.detail(GUILD, 'Nope000')).rejects.toMatchObject({ code: 'not_found' });
  });

  test('carries the evidence and reporter text as stored, since only admins read it', async () => {
    const { service } = detailRig(reportRow());

    const detail = reportDetailSchema.parse(await service.detail(GUILD, 'Xk3P9aQ'));

    expect(detail.comment).toBe(COMMENT);
    expect(detail.evidence.message).toMatchObject({
      status: 'captured',
      snapshot: { content: SNAPSHOT_TEXT, authorId: TARGET },
    });
    expect(detail).not.toHaveProperty('idempotencyKey');
    expect(detail).not.toHaveProperty('decision');
    expect(detail).not.toHaveProperty('dmChannelId');
  });

  test('evidence that no longer parses reads as empty rather than failing the page', async () => {
    const { service } = detailRig(reportRow({ evidence: { links: 'nope' } }));

    const detail = await service.detail(GUILD, 'Xk3P9aQ');

    expect(detail.evidence).toEqual({ links: [], attachments: [] });
  });

  test('adds the timeline, related reports, linked cases and 30-day member stats', async () => {
    const row = reportRow({
      status: 'accepted',
      case_ids: ['Cb81kQz'],
      resolved_by: ADMIN,
      resolved_at: iso(NOW - 10 * MINUTE),
      action_kind: 'ban',
    });
    const related = reportRow({ id: 'Rel0001', number: 5, reporter_id: SECOND_REPORTER });

    const { service, queries } = detailRig(row, [
      [
        EVENTS,
        (query) =>
          [
            {
              id: 'Xk3P9aQ:submitted:1',
              report_id: 'Xk3P9aQ',
              guild_id: GUILD,
              kind: 'submitted',
              actor_id: REPORTER,
              source: 'discord',
              data: { method: 'message_menu' },
              created_at: iso(NOW - 60 * MINUTE),
            },
            {
              id: 'Xk3P9aQ:accepted:1',
              report_id: 'Xk3P9aQ',
              guild_id: GUILD,
              kind: 'accepted',
              actor_id: ADMIN,
              source: 'dashboard',
              data: ['not', 'an', 'object'],
              created_at: iso(NOW - 10 * MINUTE),
            },
          ].map((event) => pick(query, event)),
      ],
      [RELATED, rowsOf([related])],
      [
        CASES,
        (query) => [
          pick(query, {
            id: 'Cb81kQz',
            guild_id: GUILD,
            case_number: 14,
            type: 'ban',
            actor_id: ADMIN,
            target_id: TARGET,
            moderator_id: null,
            reason: 'Posting scam links',
            module_id: 'moderation',
            payload: {},
            expires_at: null,
            reverted_at: null,
            reverted_by: null,
            dry_run: false,
            idempotency_key: 'moderation:report:Xk3P9aQ:accept:action',
            created_at: iso(NOW - 10 * MINUTE),
          }),
        ],
      ],
      [STATS, () => [['4', '3', '1']]],
    ]);

    const detail = reportDetailSchema.parse(await service.detail(GUILD, 'Xk3P9aQ'));

    expect(detail.events.map((event) => [event.kind, event.source, event.data])).toEqual([
      ['submitted', 'discord', { method: 'message_menu' }],
      ['accepted', 'dashboard', {}],
    ]);
    expect(detail.events[0]).not.toHaveProperty('guildId');
    expect(detail.related.map((report) => report.id)).toEqual(['Rel0001']);
    expect(detail.cases).toEqual([
      {
        id: 'Cb81kQz',
        caseNumber: 14,
        type: 'ban',
        actorId: ADMIN,
        targetId: TARGET,
        moderatorId: ADMIN,
        reason: 'Posting scam links',
        moduleId: 'moderation',
        expiresAt: null,
        revertedAt: null,
        revertedBy: null,
        dryRun: false,
        createdAt: iso(NOW - 10 * MINUTE),
      },
    ]);
    expect(detail.stats).toEqual({ total: 4, distinctReporters: 3, open: 1 });
    expect(detail.deciding).toBe(false);

    expect(only(queries, EVENTS).sql).toContain(
      'order by "report_events"."created_at" asc, "report_events"."id" asc',
    );

    const relatedQuery = only(queries, RELATED);
    expect(relatedQuery.sql).toContain('"reports"."target_id" = $2');
    expect(relatedQuery.params).toEqual([GUILD, TARGET, 'Xk3P9aQ', 20]);

    expect(only(queries, CASES).params).toEqual([GUILD, 'Cb81kQz']);
    expect(only(queries, STATS).params[0]).toBe(iso(NOW - 30 * DAY));
  });

  test('never asks for cases when none are linked', async () => {
    const { service, queries } = detailRig(reportRow());

    await service.detail(GUILD, 'Xk3P9aQ');

    expect(queries.some((query) => query.sql.includes(CASES))).toBe(false);
  });

  test('is deciding only while an active report holds a fresh decision', async () => {
    const decision = (startedAgo: number, status = 'open') =>
      reportRow({
        status,
        decision_token: 'req_0123456789',
        decision_kind: 'ban',
        decision_started_at: iso(NOW - startedAgo),
      });

    const deciding = async (row: Row) =>
      (await detailRig(row).service.detail(GUILD, 'Xk3P9aQ')).deciding;

    expect(await deciding(decision(MINUTE))).toBe(true);
    expect(await deciding(decision(2 * MINUTE))).toBe(false);
    expect(await deciding(decision(MINUTE, 'accepted'))).toBe(false);
    expect(await deciding(reportRow())).toBe(false);
  });
});

describe('automation runs', () => {
  test('lists runs newest first, filtered by status, with unreadable outcomes dropped', async () => {
    const { service, queries } = rig([
      [
        'from "report_automation_runs" where',
        (query) =>
          query.sql.startsWith('select count(*)')
            ? [['1']]
            : [
                pick(query, {
                  id: '01J00000000000000000000001',
                  rule_id: 'several',
                  rule_name: 'Several members report the same person',
                  target_id: TARGET,
                  episode_start: iso(0),
                  covered_until: iso(NOW - MINUTE),
                  report_ids: ['Xk3P9aQ'],
                  status: 'partial',
                  outcomes: [
                    {
                      index: 0,
                      kind: 'alert',
                      ok: false,
                      code: 'missing_permission',
                      message: 'I need Send Messages in #mods.',
                      at: NOW,
                    },
                    { index: 'x' },
                  ],
                  created_at: iso(NOW - MINUTE),
                  finished_at: iso(NOW),
                }),
              ],
      ],
    ]);

    const list = automationRunListSchema.parse(
      await service.automationRuns(GUILD, automationRunSearchSchema.parse({ status: 'partial' })),
    );

    expect(list.total).toBe(1);
    expect(list.runs).toEqual([
      {
        id: '01J00000000000000000000001',
        ruleId: 'several',
        ruleName: 'Several members report the same person',
        targetId: TARGET,
        episodeStart: 0,
        coveredUntil: NOW - MINUTE,
        reportIds: ['Xk3P9aQ'],
        status: 'partial',
        outcomes: [
          {
            index: 0,
            kind: 'alert',
            ok: false,
            code: 'missing_permission',
            message: 'I need Send Messages in #mods.',
            at: NOW,
          },
        ],
        createdAt: NOW - MINUTE,
        finishedAt: NOW,
      },
    ]);

    const [rows] = queries;
    expect(rows?.sql).toContain('"report_automation_runs"."status" = $2');
    expect(rows?.sql).toContain(
      'order by "report_automation_runs"."created_at" desc, "report_automation_runs"."id" desc',
    );
    expect(rows?.sql).not.toContain('"lease_until"');
  });
});

describe('automation run problems', () => {
  test('problem means failed or partly done', async () => {
    const { service, queries } = rig();

    await service.automationRuns(GUILD, automationRunSearchSchema.parse({ status: 'problem' }));

    expect(queries[0]?.sql).toContain('"report_automation_runs"."status" in ($2, $3)');
    expect(queries[0]?.params.slice(0, 3)).toEqual([GUILD, 'failed', 'partial']);
  });

  test('an empty status is no filter, and an unknown one is refused', () => {
    expect(automationRunSearchSchema.parse({ status: '' }).status).toBeUndefined();
    expect(automationRunSearchSchema.safeParse({ status: 'lost' }).success).toBe(false);
  });
});

describe('case evidence', () => {
  const message = (overrides: Row): Row => ({
    case_id: 'Cb81kQz',
    message_id: MESSAGE,
    guild_id: GUILD,
    channel_id: CHANNEL,
    author_id: TARGET,
    content: 'hello',
    attachments: [],
    created_at: iso(NOW - 20 * MINUTE),
    deleted_at: null,
    proof: false,
    captured_at: iso(NOW - 10 * MINUTE),
    expires_at: iso(NOW + 30 * DAY),
    ...overrides,
  });

  test('splits the proof from the history and leaves expired rows to the database', async () => {
    const { service, queries } = rig([
      [
        'from "moderation_case_messages"',
        (query) =>
          [
            message({ message_id: '600000000000000010', content: 'first' }),
            message({
              message_id: '600000000000000011',
              content: SNAPSHOT_TEXT,
              proof: true,
              attachments: [
                {
                  id: '700000000000000001',
                  filename: 'shot.png',
                  contentType: 'image/png',
                  size: 1024,
                  url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
                  expiresAt: NOW + DAY,
                },
              ],
            }),
            message({
              message_id: '600000000000000012',
              content: 'deleted later',
              deleted_at: iso(NOW - 5 * MINUTE),
              attachments: 'garbage',
            }),
          ].map((row) => pick(query, row)),
      ],
    ]);

    const evidence = caseEvidenceViewSchema.parse(await service.caseEvidence(GUILD, 'Cb81kQz'));

    expect(evidence.proof?.content).toBe(SNAPSHOT_TEXT);
    expect(evidence.proof?.attachments).toHaveLength(1);
    expect(evidence.history.map((entry) => [entry.content, entry.deletedAt])).toEqual([
      ['first', null],
      ['deleted later', NOW - 5 * MINUTE],
    ]);
    expect(evidence.history[1]?.attachments).toEqual([]);

    const [query] = queries;
    expect(query?.sql).toContain('"moderation_case_messages"."expires_at" > $3');
    expect(query?.params).toEqual([GUILD, 'Cb81kQz', iso(NOW)]);
  });

  test('a case with nothing kept has no proof and no history', async () => {
    const { service } = rig();

    expect(await service.caseEvidence(GUILD, 'Cb81kQz')).toEqual({ proof: null, history: [] });
  });
});
