import { describe, expect, test } from 'bun:test';
import {
  type EventBus,
  moderationReportActionRequestedSchema,
  type ProtonEvent,
  type ReportActionOutcome,
} from '@proton/core';
import type { NewAuditTrailEntry } from '@proton/db';
import { type ModerationConfig, moderationDefaultConfig } from '@proton/module-moderation/config';
import {
  automationRunListSchema,
  caseEvidenceViewSchema,
  reportActionResultSchema,
  reportDetailSchema,
  reportListResultSchema,
  reportSummaryCountsSchema,
} from '@proton/module-moderation/reports-view';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import type { AuditWrite } from '../src/leveling/xp-events.ts';
import {
  REPORT_ACTION_WAIT_MS,
  type ReportActionMailbox,
  ReportsService,
} from '../src/moderation/reports.ts';
import type { ModuleConfigView } from '../src/modules/service.ts';
import { fakePostgres, pick } from './fake-postgres.ts';
import {
  ADMIN,
  COMMENT,
  GUILD,
  MODERATOR,
  NOW,
  OTHER_GUILD,
  type Row,
  reportRow,
  SNAPSHOT_TEXT,
  TARGET,
} from './report-rows.ts';

const SECRET = 'shared-secret-for-tests';
const REPORT = 'Xk3P9aQ';
const REQUEST = 'req_0123456789';
const MAILBOX_ID = `${GUILD}:${REQUEST}`;

const ACTIONS = `/guilds/${GUILD}/moderation/reports/${REPORT}/actions`;

const ACCESS_WORDS = /forbidden|not signed in|do not administer|lack the required permission/i;

const HERE = {
  presence: (ids: readonly string[]) => Promise.resolve({ present: [...ids], known: true }),
};

const GONE = {
  presence: () => Promise.resolve({ present: [], known: true }),
};

const ACCEPTED: ReportActionOutcome = {
  ok: true,
  code: 'accepted',
  message: 'Report `Xk3P9aQ` accepted. The member was banned.',
  caseId: 'Cb81kQz',
};

const REASON = 'Posting scam links after a warning';
const NOTE = 'Checked the link, it is a known phishing domain';
const REPORTER_NOTE = 'Thanks, we removed the member.';

const ACCEPT = {
  action: 'accept',
  params: {
    punishment: 'ban' as const,
    reason: REASON,
    duration: '7d',
    deleteMessage: true,
    note: NOTE,
    reporterNote: REPORTER_NOTE,
  },
  requestId: REQUEST,
  actorId: ADMIN,
  actorPermissions: '32',
  source: 'dashboard',
  ipHash: 'hash123',
};

interface HarnessOptions {
  moduleEnabled?: boolean;
  config?: Partial<ModerationConfig>;
  rows?: Row[];
  kept?: Record<string, ReportActionOutcome>;
  answer?: ReportActionOutcome | null;
  bus?: false;
  mailbox?: false;
  failPublish?: boolean;
  guilds?: unknown;
}

function harness(options: HarnessOptions = {}) {
  const order: string[] = [];
  const audits: NewAuditTrailEntry[] = [];
  const events: ProtonEvent[] = [];
  const waits: Array<[string, number]> = [];
  const recalls: string[] = [];
  const logs: string[] = [];
  const rows = options.rows ?? [reportRow()];

  const { handle, queries } = fakePostgres((query) => {
    if (!query.sql.includes('"reports"."id" = $2) limit')) return [];

    order.push('db');
    const [guildId, id] = query.params;
    const row = rows.find((candidate) => candidate.guild_id === guildId && candidate.id === id);
    return row ? [pick(query, row)] : [];
  });

  const config: ModerationConfig = {
    ...moderationDefaultConfig,
    reports: { ...moderationDefaultConfig.reports, enabled: true },
    ...options.config,
  };

  const modules = {
    get: async (_guildId: string, moduleId: string): Promise<ModuleConfigView> => {
      order.push('modules');
      return {
        moduleId,
        enabled: options.moduleEnabled ?? true,
        config,
        schemaVersion: 3,
        migrated: false,
        tier: 'free',
        postables: [],
        simulations: [],
      };
    },
  };

  const audit: AuditWrite = async (entry) => {
    order.push('audit');
    audits.push(JSON.parse(JSON.stringify(entry)));
  };

  const bus: EventBus = {
    publish: async (event) => {
      order.push('publish');
      if (options.failPublish) throw new Error('READONLY You cannot write against a replica.');
      events.push(JSON.parse(JSON.stringify(event)));
    },
    subscribe: () => {
      throw new Error('the api never subscribes');
    },
  };

  const kept = options.kept ?? {};

  const mailbox: ReportActionMailbox = {
    recall: async (id) => {
      order.push('recall');
      recalls.push(id);
      return kept[id] ?? null;
    },
    wait: async (id, timeoutMs) => {
      order.push('wait');
      waits.push([id, timeoutMs]);
      return options.answer === undefined ? ACCEPTED : options.answer;
    },
  };

  const reports = new ReportsService({
    db: handle,
    modules,
    audit,
    ...(options.bus === false ? {} : { bus }),
    ...(options.mailbox === false ? {} : { mailbox }),
    logger: { error: (line: string) => logs.push(line) },
    now: () => NOW,
  });

  const app = createApiApp({
    guilds: options.guilds ?? HERE,
    reports,
    sharedSecret: SECRET,
  } as unknown as ApiDeps);

  return { app, order, audits, events, waits, recalls, logs, queries };
}

const NO_SECRET = Symbol('no secret');

function send(
  app: ReturnType<typeof createApiApp>,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; secret?: string | typeof NO_SECRET } = {},
) {
  const secret = options.secret ?? SECRET;

  return app.request(path, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(secret === NO_SECRET ? {} : { 'x-proton-secret': secret }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function act(app: ReturnType<typeof createApiApp>, body: unknown = ACCEPT, path = ACTIONS) {
  return send(app, path, { method: 'POST', body });
}

interface Refusal {
  error: string;
  message: string;
}

async function refusal(response: Response): Promise<Refusal> {
  return (await response.json()) as Refusal;
}

describe('POST /guilds/:guildId/moderation/reports/:reportId/actions', () => {
  test('is refused without the shared secret, before anything is read', async () => {
    const h = harness();

    expect(
      (await send(h.app, ACTIONS, { method: 'POST', body: ACCEPT, secret: NO_SECRET })).status,
    ).toBe(401);
    expect(h.order).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  test('is refused with bot_absent when Discord says Proton left, saying nothing was done', async () => {
    const h = harness({ guilds: GONE });

    const response = await act(h.app);

    expect(response.status).toBe(409);
    expect(await refusal(response)).toEqual({
      error: 'bot_absent',
      message:
        'Discord says Proton is not in this server, so nothing was done. Invite Proton back to ' +
        'the server and try again.',
    });
    expect(h.order).toEqual([]);
  });

  test('recalls, checks the module, reads the report, audits, publishes, then waits', async () => {
    const h = harness();

    const response = await act(h.app);

    expect(response.status).toBe(200);
    expect(h.order).toEqual(['recall', 'modules', 'db', 'audit', 'publish', 'wait']);
    expect(h.recalls).toEqual([MAILBOX_ID]);
    expect(h.waits).toEqual([[MAILBOX_ID, REPORT_ACTION_WAIT_MS]]);
  });

  test('the audit row names the action and keeps note lengths, never their text', async () => {
    const h = harness();

    await act(h.app);

    expect(h.audits).toEqual([
      {
        id: `report.accept:${GUILD}:${REQUEST}`,
        guildId: GUILD,
        actorId: ADMIN,
        source: 'dashboard',
        action: 'module.moderation.report.accept',
        before: {
          reportId: REPORT,
          number: 7,
          status: 'open',
          targetId: TARGET,
          assigneeId: null,
          actionKind: null,
          caseIds: [],
          cardState: 'posted',
        },
        after: {
          action: 'accept',
          requestId: REQUEST,
          punishment: 'ban',
          duration: '7d',
          deleteMessage: true,
          reasonLength: REASON.length,
          noteLength: NOTE.length,
          reporterNoteLength: REPORTER_NOTE.length,
        },
        ipHash: 'hash123',
      },
    ]);

    const written = JSON.stringify(h.audits);
    for (const text of [COMMENT, SNAPSHOT_TEXT, REASON, NOTE, REPORTER_NOTE]) {
      expect(written).not.toContain(text);
    }
  });

  test('publishes the request under a guild-scoped id with the audit id and full params', async () => {
    const h = harness();

    await act(h.app);

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      id: `moderation.report_action_requested:${GUILD}:${REQUEST}`,
      type: 'moderation.report_action_requested',
      guildId: GUILD,
      occurredAt: NOW,
    });
    expect(moderationReportActionRequestedSchema.parse(h.events[0]?.payload)).toEqual({
      requestId: REQUEST,
      auditId: h.audits[0]?.id ?? '',
      guildId: GUILD,
      reportId: REPORT,
      action: 'accept',
      params: ACCEPT.params,
      actorId: ADMIN,
      actorPermissions: '32',
    });
  });

  test("answers with the worker's outcome as it came, success or refusal", async () => {
    const refused: ReportActionOutcome = {
      ok: false,
      code: 'self_review',
      message: "You can't review a report about yourself.",
    };
    const confirm: ReportActionOutcome = {
      ok: false,
      code: 'needs_confirmation',
      message: '<@200000000000000001> was punished 2 minutes ago. Accept again to go ahead.',
      needsConfirmation: 'recent_case',
    };

    for (const answer of [ACCEPTED, refused, confirm]) {
      const response = await act(harness({ answer }).app);

      expect(response.status).toBe(200);
      expect(reportActionResultSchema.parse(await response.json())).toEqual(answer);
    }
  });

  test('a kept answer is returned at once: nothing is read, audited, published or awaited', async () => {
    const h = harness({ kept: { [MAILBOX_ID]: ACCEPTED } });

    const response = await act(h.app);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(ACCEPTED);
    expect(h.order).toEqual(['recall']);
    expect(h.audits).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test('the kept answer wins even after Moderation was switched off or the bus went away', async () => {
    for (const options of [{ moduleEnabled: false }, { bus: false as const }]) {
      const h = harness({ ...options, kept: { [MAILBOX_ID]: ACCEPTED } });

      const response = await act(h.app);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(ACCEPTED);
    }
  });

  test("another server's answer under the same request id is not this request's answer", async () => {
    const h = harness({ kept: { [`${OTHER_GUILD}:${REQUEST}`]: ACCEPTED } });

    expect((await act(h.app)).status).toBe(200);
    expect(h.recalls).toEqual([MAILBOX_ID]);
    expect(h.events).toHaveLength(1);
  });

  test('409 worker_timeout says the action may still complete and to refresh', async () => {
    const h = harness({ answer: null });

    const response = await act(h.app);
    const body = await refusal(response);

    expect(response.status).toBe(409);
    expect(body.error).toBe('worker_timeout');
    expect(body.message).toContain('may still complete');
    expect(body.message).toContain('refresh the report');
    expect(h.audits).toHaveLength(1);
    expect(h.events).toHaveLength(1);
  });

  test('409 module_disabled when Moderation is off, whichever switch is off', async () => {
    for (const options of [{ moduleEnabled: false }, { config: { enabled: false } }]) {
      const h = harness(options);

      const response = await act(h.app);

      expect(response.status).toBe(409);
      expect(await refusal(response)).toEqual({
        error: 'module_disabled',
        message: 'Moderation is off in this server, so nothing was done. Turn it on first.',
      });
      expect(h.audits).toHaveLength(0);
      expect(h.events).toHaveLength(0);
    }
  });

  test('User Reports being off does not stop review of existing reports', async () => {
    const h = harness({
      config: { reports: { ...moderationDefaultConfig.reports, enabled: false } },
    });

    const response = await act(h.app, { ...ACCEPT, action: 'dismiss', params: {} });

    expect(response.status).toBe(200);
    expect(h.events).toHaveLength(1);
    expect(h.audits[0]?.action).toBe('module.moderation.report.dismiss');
  });

  test('404 not_found for a report this server does not have, with nothing audited', async () => {
    const h = harness({ rows: [reportRow({ guild_id: OTHER_GUILD })] });

    const response = await act(h.app);
    const body = await refusal(response);

    expect(response.status).toBe(404);
    expect(body.error).toBe('not_found');
    expect(body.message).toContain('`Xk3P9aQ`');
    expect(h.audits).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test('404 for a report about the member acting, with nothing audited or published', async () => {
    const h = harness({ rows: [reportRow({ target_id: ADMIN })] });

    const response = await act(h.app);

    expect(response.status).toBe(404);
    expect((await refusal(response)).error).toBe('not_found');
    expect(h.audits).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  test('400 invalid_body for a malformed request, before anything is read', async () => {
    const h = harness();

    for (const body of [
      { ...ACCEPT, action: 'reopen' },
      { ...ACCEPT, requestId: 'short' },
      { ...ACCEPT, actorId: 'someone' },
      { ...ACCEPT, actorPermissions: 'all' },
      { ...ACCEPT, source: 'command' },
      { ...ACCEPT, params: { ...ACCEPT.params, note: 'x'.repeat(1001) } },
      { ...ACCEPT, params: { punishment: 'mute' } },
      null,
    ]) {
      const response = await act(h.app, body);

      expect(response.status).toBe(400);
      expect((await refusal(response)).error).toBe('invalid_body');
    }
    expect(h.order).toEqual([]);
  });

  test('400 invalid_request for an assignment that names nobody, and none is allowed', async () => {
    const assign = { ...ACCEPT, action: 'assign', params: {} };

    const missing = harness();
    const response = await act(missing.app, assign);
    expect(response.status).toBe(400);
    expect((await refusal(response)).error).toBe('invalid_request');
    expect(missing.audits).toHaveLength(0);

    const cleared = harness();
    expect((await act(cleared.app, { ...assign, params: { assigneeId: null } })).status).toBe(200);
    expect(
      (await act(harness().app, { ...assign, params: { assigneeId: MODERATOR } })).status,
    ).toBe(200);
  });

  test('400 invalid_request for a path that names no Discord server', async () => {
    const h = harness();

    const response = await act(
      h.app,
      ACCEPT,
      `/guilds/not-a-guild/moderation/reports/${REPORT}/actions`,
    );

    expect(response.status).toBe(400);
    expect((await refusal(response)).error).toBe('invalid_request');
    expect(h.audits).toHaveLength(0);
  });

  test('503 no_redis without a mailbox, before anything else', async () => {
    const h = harness({ mailbox: false });

    const response = await act(h.app);
    const body = await refusal(response);

    expect(response.status).toBe(503);
    expect(body.error).toBe('no_redis');
    expect(body.message).toContain('Proton can’t act on reports right now');
    expect(h.order).toEqual([]);
  });

  test('503 no_bus without an event bus, after the recall and before any audit', async () => {
    const h = harness({ bus: false });

    const response = await act(h.app);

    expect(response.status).toBe(503);
    expect((await refusal(response)).error).toBe('no_bus');
    expect(h.order).toEqual(['recall']);
  });

  test('a failed publish is refused as no_bus, logged, and never awaited', async () => {
    const h = harness({ failPublish: true });

    const response = await act(h.app);
    const body = await refusal(response);

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: 'no_bus',
      message: 'Proton couldn’t start that action, so nothing was done. Try again in a moment.',
    });
    expect(h.order).toEqual(['recall', 'modules', 'db', 'audit', 'publish']);
    expect(h.logs.join('\n')).toContain('READONLY');
  });

  test('no refusal reads as a revoked sign-in', async () => {
    const responses = [
      await act(harness({ guilds: GONE }).app),
      await act(harness({ answer: null }).app),
      await act(harness({ moduleEnabled: false }).app),
      await act(harness({ rows: [] }).app),
      await act(harness({ mailbox: false }).app),
      await act(harness({ bus: false }).app),
      await act(harness({ failPublish: true }).app),
      await act(harness().app, { ...ACCEPT, action: 'assign', params: {} }),
    ];

    for (const response of responses) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect((await refusal(response)).message).not.toMatch(ACCESS_WORDS);
    }
  });
});

describe('GET report routes', () => {
  test('are refused without the shared secret', async () => {
    const h = harness();

    for (const path of [
      `/guilds/${GUILD}/moderation/reports`,
      `/guilds/${GUILD}/moderation/reports/summary`,
      `/guilds/${GUILD}/moderation/reports/automation/runs`,
      `/guilds/${GUILD}/moderation/reports/${REPORT}`,
      `/guilds/${GUILD}/cases/Cb81kQz/evidence`,
    ]) {
      expect((await send(h.app, path, { secret: NO_SECRET })).status).toBe(401);
    }
    expect(h.queries).toHaveLength(0);
  });

  test('are not behind the write-presence gate', async () => {
    const h = harness({ guilds: GONE });

    expect((await send(h.app, `/guilds/${GUILD}/moderation/reports`)).status).toBe(200);
    expect((await send(h.app, `/guilds/${GUILD}/moderation/reports/${REPORT}`)).status).toBe(200);
  });

  test('the queue answers in the shared list shape', async () => {
    const response = await send(harness().app, `/guilds/${GUILD}/moderation/reports?status=all`);

    expect(response.status).toBe(200);
    expect(reportListResultSchema.parse(await response.json())).toEqual({
      grouped: false,
      reports: [],
      total: 0,
      page: 1,
      pageSize: 25,
    });
  });

  test('400 invalid_query for filters the queue cannot honour', async () => {
    const h = harness();

    for (const query of [
      'status=closed',
      'pageSize=31',
      'page=0',
      'sort=volume',
      'assigneeId=bob',
      'from=2026-09-10&to=2026-09-01',
      'delivery=late',
      'close=late',
      'viewerId=someone',
    ]) {
      const response = await send(h.app, `/guilds/${GUILD}/moderation/reports?${query}`);

      expect(response.status).toBe(400);
      expect((await refusal(response)).error).toBe('invalid_query');
    }
    expect(h.queries).toHaveLength(0);
  });

  test('summary and automation runs are not read as report ids', async () => {
    const h = harness();

    const summary = await send(h.app, `/guilds/${GUILD}/moderation/reports/summary`);
    const runs = await send(h.app, `/guilds/${GUILD}/moderation/reports/automation/runs`);

    expect(summary.status).toBe(200);
    expect(reportSummaryCountsSchema.parse(await summary.json()).openUnclaimed).toBe(0);
    expect(runs.status).toBe(200);
    expect(automationRunListSchema.parse(await runs.json()).runs).toEqual([]);
    expect(h.order).not.toContain('db');
  });

  test('the viewer’s id keeps reports about them out of every read', async () => {
    const h = harness({ rows: [reportRow({ target_id: MODERATOR })] });
    const viewer = `viewerId=${MODERATOR}`;

    const list = await send(h.app, `/guilds/${GUILD}/moderation/reports?close=problem&${viewer}`);
    const summary = await send(h.app, `/guilds/${GUILD}/moderation/reports/summary?${viewer}`);
    const runs = await send(
      h.app,
      `/guilds/${GUILD}/moderation/reports/automation/runs?status=problem&${viewer}`,
    );
    const detail = await send(h.app, `/guilds/${GUILD}/moderation/reports/${REPORT}?${viewer}`);

    expect([list.status, summary.status, runs.status]).toEqual([200, 200, 200]);
    expect(detail.status).toBe(404);
    expect((await refusal(detail)).error).toBe('not_found');

    const reads = h.queries.filter((query) => !query.sql.includes('"reports"."id" = $2) limit'));
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const query of reads) expect(query.params).toContain(MODERATOR);
  });

  test('400 invalid_query for a viewer id that is not a Discord id', async () => {
    const h = harness();

    for (const path of [
      `/guilds/${GUILD}/moderation/reports/summary?viewerId=x`,
      `/guilds/${GUILD}/moderation/reports/automation/runs?viewerId=x`,
      `/guilds/${GUILD}/moderation/reports/${REPORT}?viewerId=x`,
    ]) {
      const response = await send(h.app, path);

      expect(response.status).toBe(400);
      expect((await refusal(response)).error).toBe('invalid_query');
    }
    expect(h.queries).toHaveLength(0);
  });

  test('400 invalid_query for an unknown automation run status', async () => {
    const response = await send(
      harness().app,
      `/guilds/${GUILD}/moderation/reports/automation/runs?status=lost`,
    );

    expect(response.status).toBe(400);
    expect((await refusal(response)).error).toBe('invalid_query');
  });

  test('a report answers in the shared detail shape, and a missing one is 404', async () => {
    const h = harness();

    const found = await send(h.app, `/guilds/${GUILD}/moderation/reports/${REPORT}`);
    expect(found.status).toBe(200);
    expect(reportDetailSchema.parse(await found.json()).id).toBe(REPORT);

    const missing = await send(h.app, `/guilds/${GUILD}/moderation/reports/nope123`);
    expect(missing.status).toBe(404);
    expect((await refusal(missing)).error).toBe('not_found');
  });

  test('case evidence answers in the shared shape', async () => {
    const response = await send(harness().app, `/guilds/${GUILD}/cases/Cb81kQz/evidence`);

    expect(response.status).toBe(200);
    expect(caseEvidenceViewSchema.parse(await response.json())).toEqual({
      proof: null,
      history: [],
    });
  });
});
