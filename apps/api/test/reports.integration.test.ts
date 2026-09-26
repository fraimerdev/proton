import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  moderationReportActionRequestedSchema,
  REPORT_ACTION_MAILBOX_PREFIX,
  RedisMailbox,
  RedisStreamsEventBus,
  type ReportActionOutcome,
  reportActionOutcomeSchema,
  streamKey,
} from '@proton/core';
import { createDb, type DbHandle, runMigrations } from '@proton/db';
import { cases, guilds } from '@proton/db/schema';
import { moderationDefaultConfig } from '@proton/module-moderation/config';
import {
  automationRunQuerySchema,
  type ReportQueryInput,
  reportDetailSchema,
  reportListResultSchema,
  reportQuerySchema,
} from '@proton/module-moderation/reports-view';
import {
  moderationCaseMessages,
  type NewReportRow,
  reportAutomationRuns,
  reportEvents,
  reports,
} from '@proton/module-moderation/tables';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import { auditTrailWriter } from '../src/leveling/xp-events.ts';
import {
  automationRunSearchSchema,
  ReportsService,
  reportSearchSchema,
} from '../src/moderation/reports.ts';
import type { ModuleConfigView } from '../src/modules/service.ts';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let handle: DbHandle;
let redis: Redis;

const SECRET = 'shared-secret-for-tests';
const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const ADMIN = '100000000000000001';
const MODERATOR = '100000000000000002';
const REPORTER = '300000000000000001';
const SECOND_REPORTER = '300000000000000002';
const T1 = '200000000000000001';
const T2 = '200000000000000002';
const T3 = '200000000000000003';
const CHANNEL = '500000000000000001';

const MINUTE = 60_000;
const DAY = 86_400_000;
const NOW = Date.now();

const REQUESTS = streamKey('moderation.report_action_requested');

const HERE = {
  presence: (ids: readonly string[]) => Promise.resolve({ present: [...ids], known: true }),
};

const modules = {
  get: async (_guildId: string, moduleId: string): Promise<ModuleConfigView> => ({
    moduleId,
    enabled: true,
    config: moderationDefaultConfig,
    schemaVersion: 3,
    migrated: false,
    tier: 'free',
    postables: [],
    simulations: [],
  }),
};

function report(
  id: string,
  number: number,
  minutesAgo: number,
  overrides: Partial<NewReportRow> = {},
): NewReportRow {
  return {
    id,
    guildId: GUILD,
    number,
    reporterId: REPORTER,
    targetId: T1,
    method: 'command',
    status: 'open',
    cardState: 'posted',
    idempotencyKey: `seed:${id}`,
    createdAt: new Date(NOW - minutesAgo * MINUTE),
    ...overrides,
  };
}

function service(options: { waitMs?: number } = {}) {
  return new ReportsService({
    db: handle,
    modules,
    audit: auditTrailWriter(handle),
    bus: new RedisStreamsEventBus(redis, { blockMs: 100 }),
    mailbox: new RedisMailbox<ReportActionOutcome>(redis, {
      prefix: REPORT_ACTION_MAILBOX_PREFIX,
      schema: reportActionOutcomeSchema,
    }),
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    now: () => NOW,
  });
}

function search(input: ReportQueryInput = {}, guildId = GUILD) {
  return service().search(guildId, reportQuerySchema.parse(input));
}

async function ids(input: ReportQueryInput = {}): Promise<string[]> {
  const result = reportListResultSchema.parse(await search(input));
  if (result.grouped) throw new Error('expected a flat list');
  return result.reports.map((row) => row.id);
}

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  handle = createDb(postgres.getConnectionUri());
  await runMigrations(handle);
  redis = new Redis(redisContainer.getConnectionUrl());

  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);

  await handle.db.insert(reports).values([
    report('Aa_0001', 1, 50, { cardState: 'failed', cardError: 'I need Send Messages.' }),
    report('Bb00002', 2, 40, {
      reporterId: SECOND_REPORTER,
      status: 'in_review',
      assigneeId: MODERATOR,
    }),
    report('Cc00003', 3, 30, {
      status: 'accepted',
      caseIds: ['CaseA01', 'CaseZ99'],
      comment: 'they posted the link three times',
      evidence: {
        message: {
          status: 'captured',
          snapshot: { id: '600000000000000001', channelId: CHANNEL, url: 'x', content: 'scam' },
        },
        links: [],
        attachments: [],
      },
    }),
    report('Dd00004', 4, 20, { targetId: T2, closeError: 'I need Manage Messages.' }),
    report('Ee00005', 5, 10, { targetId: T2, reporterId: SECOND_REPORTER, status: 'dismissed' }),
    report('Ff00006', 6, 20, { targetId: T3, reporterId: SECOND_REPORTER }),
    ...Array.from({ length: 7 }, (_, i) =>
      report(`Zz0000${i + 1}`, i + 1, 70 - i, { guildId: OTHER_GUILD }),
    ),
  ]);

  await handle.db.insert(reportEvents).values([
    {
      id: 'Cc00003:accepted:1',
      reportId: 'Cc00003',
      guildId: GUILD,
      kind: 'accepted',
      actorId: ADMIN,
      source: 'dashboard',
      createdAt: new Date(NOW - 25 * MINUTE),
    },
    {
      id: 'Cc00003:submitted:1',
      reportId: 'Cc00003',
      guildId: GUILD,
      kind: 'submitted',
      actorId: REPORTER,
      source: 'discord',
      data: { method: 'command' },
      createdAt: new Date(NOW - 30 * MINUTE),
    },
  ]);

  await handle.db.insert(cases).values([
    {
      id: 'CaseA01',
      guildId: GUILD,
      caseNumber: 1,
      type: 'ban',
      actorId: ADMIN,
      targetId: T1,
      moduleId: 'moderation',
      idempotencyKey: 'moderation:report:Cc00003:accept:action',
    },
    {
      id: 'CaseZ99',
      guildId: OTHER_GUILD,
      caseNumber: 1,
      type: 'ban',
      actorId: ADMIN,
      targetId: T1,
      moduleId: 'moderation',
      idempotencyKey: 'elsewhere',
    },
  ]);

  const run = (id: string, status: string, daysAgo: number) => ({
    id,
    guildId: GUILD,
    ruleId: 'several',
    ruleName: 'Several members report the same person',
    targetId: T1,
    episodeStart: new Date(NOW - (daysAgo + 1) * DAY),
    coveredUntil: new Date(NOW - daysAgo * DAY),
    status,
    leaseUntil: new Date(NOW - daysAgo * DAY),
    outcomes: [],
    createdAt: new Date(NOW - daysAgo * DAY),
  });

  await handle.db
    .insert(reportAutomationRuns)
    .values([
      run('run-1', 'failed', 1),
      run('run-2', 'partial', 2),
      run('run-3', 'done', 3),
      run('run-4', 'failed', 8),
    ]);

  const kept = (messageId: string, proof: boolean, expiresIn: number) => ({
    caseId: 'CaseA01',
    messageId,
    guildId: GUILD,
    channelId: CHANNEL,
    authorId: T1,
    content: `message ${messageId}`,
    attachments: [],
    createdAt: new Date(NOW - 60 * MINUTE),
    proof,
    expiresAt: new Date(NOW + expiresIn),
  });

  await handle.db
    .insert(moderationCaseMessages)
    .values([
      kept('600000000000000011', true, DAY),
      kept('600000000000000012', false, DAY),
      kept('600000000000000013', false, -MINUTE),
    ]);
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await handle?.close();
  await Promise.all([postgres?.stop(), redisContainer?.stop()]);
}, 240_000);

describe('the report queue against Postgres', () => {
  test('active reports newest first, the number breaking a tie in time', async () => {
    expect(await ids()).toEqual(['Ff00006', 'Dd00004', 'Bb00002', 'Aa_0001']);
  });

  test('never shows another server’s reports', async () => {
    const result = await search({ status: 'all' });

    expect(result.total).toBe(6);
  });

  test('filters by number, escaped id text, assignee, delivery and member', async () => {
    expect(await ids({ status: 'all', q: '#3' })).toEqual(['Cc00003']);
    expect(await ids({ status: 'all', q: '_0' })).toEqual(['Aa_0001']);
    expect(await ids({ assigneeId: 'none' })).toEqual(['Ff00006', 'Dd00004', 'Aa_0001']);
    expect(await ids({ status: 'all', delivery: 'problem' })).toEqual(['Aa_0001']);
    expect(await ids({ status: 'all', q: T2 })).toEqual(['Ee00005', 'Dd00004']);
  });

  test('groups by member, ranked by volume, with the newest reports under each', async () => {
    const result = reportListResultSchema.parse(
      await search({ status: 'all', group: 'member', sort: 'volume' }),
    );
    if (!result.grouped) throw new Error('expected groups');

    expect(result.total).toBe(3);
    expect(
      result.groups.map((group) => [
        group.targetId,
        group.total,
        group.open,
        group.distinctReporters,
        group.reports.map((row) => row.id),
      ]),
    ).toEqual([
      [T1, 3, 2, 2, ['Cc00003', 'Bb00002', 'Aa_0001']],
      [T2, 2, 1, 2, ['Ee00005', 'Dd00004']],
      [T3, 1, 1, 1, ['Ff00006']],
    ]);
  });

  test('a group previews at most five reports', async () => {
    const result = reportListResultSchema.parse(await search({ group: 'member' }, OTHER_GUILD));
    if (!result.grouped) throw new Error('expected groups');

    expect(result.groups[0]?.total).toBe(7);
    expect(result.groups[0]?.reports.map((row) => row.id)).toEqual([
      'Zz00007',
      'Zz00006',
      'Zz00005',
      'Zz00004',
      'Zz00003',
    ]);
  });

  test('the summary counts statuses, problems and recent automation failures', async () => {
    expect(await service().summary(GUILD)).toEqual({
      counts: { open: 3, in_review: 1, accepted: 1, dismissed: 1 },
      openUnclaimed: 3,
      oldestOpenAt: NOW - 50 * MINUTE,
      deliveryProblems: 1,
      closeProblems: 1,
      automationFailures7d: 2,
    });
  });

  test('a report in detail carries its timeline, related reports, own cases and stats', async () => {
    const detail = reportDetailSchema.parse(await service().detail(GUILD, 'Cc00003'));

    expect(detail.comment).toBe('they posted the link three times');
    expect(detail.events.map((event) => event.kind)).toEqual(['submitted', 'accepted']);
    expect(detail.related.map((row) => row.id)).toEqual(['Bb00002', 'Aa_0001']);
    expect(detail.cases.map((row) => row.id)).toEqual(['CaseA01']);
    expect(detail.stats).toEqual({ total: 3, distinctReporters: 2, open: 2 });
  });

  test('automation runs filter by status, newest first', async () => {
    const list = await service().automationRuns(
      GUILD,
      automationRunQuerySchema.parse({ status: 'failed' }),
    );

    expect(list.total).toBe(2);
    expect(list.runs.map((run) => run.id)).toEqual(['run-1', 'run-4']);
  });

  test('a close that failed is its own filter', async () => {
    const result = reportListResultSchema.parse(
      await service().search(GUILD, reportSearchSchema.parse({ status: 'all', close: 'problem' })),
    );

    expect(result.grouped ? [] : result.reports.map((row) => row.id)).toEqual(['Dd00004']);
  });

  test('the viewer never sees reports about themselves, in any read', async () => {
    const viewing = service();
    const listed = reportListResultSchema.parse(
      await viewing.search(GUILD, reportSearchSchema.parse({ status: 'all' }), T1),
    );

    expect(listed.total).toBe(3);
    expect(listed.grouped ? [] : listed.reports.map((row) => row.targetId)).not.toContain(T1);
    await expect(viewing.detail(GUILD, 'Cc00003', T1)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await viewing.summary(GUILD, T1)).counts).toEqual({
      open: 2,
      in_review: 0,
      accepted: 0,
      dismissed: 1,
    });
    expect(
      (await viewing.automationRuns(GUILD, automationRunSearchSchema.parse({}), T1)).total,
    ).toBe(0);
  });

  test('failed or partly done runs are one filter', async () => {
    const list = await service().automationRuns(
      GUILD,
      automationRunSearchSchema.parse({ status: 'problem' }),
    );

    expect(list.runs.map((run) => run.id)).toEqual(['run-1', 'run-2', 'run-4']);
  });

  test('case evidence leaves out expired messages', async () => {
    const evidence = await service().caseEvidence(GUILD, 'CaseA01');

    expect(evidence.proof?.messageId).toBe('600000000000000011');
    expect(evidence.history.map((entry) => entry.messageId)).toEqual(['600000000000000012']);
  });
});

describe('acting on a report through Redis', () => {
  const REQUEST = 'req_integration_1';
  const CLAIMED: ReportActionOutcome = { ok: true, code: 'claimed', message: 'Claimed.' };

  beforeEach(async () => {
    await redis.flushall();
    await handle.client`delete from audit_trail`;
  });

  function app(reportsService: ReportsService) {
    return createApiApp({
      guilds: HERE,
      reports: reportsService,
      sharedSecret: SECRET,
    } as unknown as ApiDeps);
  }

  const claim = (target: ReturnType<typeof createApiApp>) =>
    target.request(`/guilds/${GUILD}/moderation/reports/Aa_0001/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-proton-secret': SECRET },
      body: JSON.stringify({
        action: 'claim',
        params: {},
        requestId: REQUEST,
        actorId: ADMIN,
        actorPermissions: '32',
        source: 'dashboard',
      }),
    });

  async function audits() {
    return (await handle.client`
      select id, action from audit_trail order by id
    `) as unknown as Array<{ id: string; action: string }>;
  }

  test('the worker’s answer comes back, and a retry is answered from the mailbox', async () => {
    const worker = new RedisStreamsEventBus(redis, { blockMs: 100 });
    const answers = new RedisMailbox<ReportActionOutcome>(redis, {
      prefix: REPORT_ACTION_MAILBOX_PREFIX,
      schema: reportActionOutcomeSchema,
    });

    const subscription = worker.subscribe(
      'moderation-test',
      ['moderation.report_action_requested'],
      async (event) => {
        const request = moderationReportActionRequestedSchema.parse(event.payload);
        await answers.answer(`${request.guildId}:${request.requestId}`, CLAIMED);
      },
      { startId: '0' },
    );

    try {
      const api = app(service());

      const first = await claim(api);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual(CLAIMED);

      const again = await claim(api);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(CLAIMED);

      expect(await redis.xlen(REQUESTS)).toBe(1);
      expect(await audits()).toEqual([
        { id: `report.claim:${GUILD}:${REQUEST}`, action: 'module.moderation.report.claim' },
      ]);
    } finally {
      await subscription.close();
    }
  }, 30_000);

  test('409 worker_timeout when nobody answers, after auditing and publishing once', async () => {
    const response = await claim(app(service({ waitMs: 1_000 })));

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('worker_timeout');
    expect(await redis.xlen(REQUESTS)).toBe(1);
    expect(await audits()).toHaveLength(1);
  }, 30_000);
});
