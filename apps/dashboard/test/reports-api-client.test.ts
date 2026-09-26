import { afterEach, describe, expect, test } from 'bun:test';
import {
  ApiClient,
  ApiError,
  automationRunListQuerySchema,
  reportListQuerySchema,
} from '../src/lib/api-client.ts';

const GUILD = '900000000000000002';
const ACTOR = '400000000000000001';
const TARGET = '400000000000000002';
const REPORTER = '400000000000000003';
const REPORT = 'Rk7f3M2q';
const CASE = 'K7f3M2q';
const NOW = Date.parse('2026-09-18T14:00:00.000Z');

const realFetch = globalThis.fetch;

let calls: { url: string; init: RequestInit }[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  calls = [];
});

function answer(status: number, body: unknown) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the api client to throw');
}

const api = () => new ApiClient('http://api.test/', 'secret');

const card = {
  channelId: null,
  messageId: null,
  evidenceMessageId: null,
  state: 'posted',
  error: null,
  attempts: 1,
  version: 0,
};

const close = { action: null, dueAt: null, closedAt: null, attempts: 0, error: null };

const summary = {
  id: REPORT,
  number: 7,
  status: 'open',
  method: 'message_menu',
  reporterId: REPORTER,
  targetId: TARGET,
  reasonId: 'spam',
  reason: 'Spam',
  customReason: null,
  sourceChannelId: '500000000000000001',
  sourceMessageId: '600000000000000001',
  assigneeId: null,
  assignedAt: null,
  resolvedBy: null,
  resolvedAt: null,
  actionKind: null,
  caseIds: [],
  card,
  close,
  evidencePurgedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const detail = {
  ...summary,
  guildId: GUILD,
  comment: 'They keep posting invite links.',
  sourceAuthorId: TARGET,
  evidence: { links: [], attachments: [] },
  evidenceExpiresAt: NOW + 90 * 86_400_000,
  resolutionNote: null,
  reporterNote: null,
  notifications: {},
  version: 1,
  deciding: true,
  events: [
    {
      id: 'e1',
      reportId: REPORT,
      kind: 'submitted',
      actorId: REPORTER,
      source: 'discord',
      data: { method: 'message_menu', links: 0 },
      createdAt: NOW,
    },
  ],
  related: [],
  cases: [],
  stats: { total: 1, distinctReporters: 1, open: 1 },
};

const query = reportListQuerySchema.parse({ status: 'open', q: '#7', page: 2 });

describe('ApiClient.searchReports', () => {
  test('sends the query without the keys it leaves out, and parses a flat page', async () => {
    answer(200, { grouped: false, reports: [summary], total: 1, page: 2, pageSize: 25 });

    const result = await api().searchReports(GUILD, query, ACTOR);
    const url = new URL(calls[0]?.url ?? '');

    expect(url.pathname).toBe(`/guilds/${GUILD}/moderation/reports`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'open',
      q: '#7',
      sort: 'created',
      dir: 'desc',
      page: '2',
      pageSize: '25',
      viewerId: ACTOR,
    });
    expect(new Headers(calls[0]?.init.headers).get('x-proton-secret')).toBe('secret');
    expect(result.grouped).toBe(false);
    expect(result.grouped ? [] : result.reports.map((report) => report.number)).toEqual([7]);
  });

  test('parses the grouped view', async () => {
    answer(200, {
      grouped: true,
      groups: [
        {
          targetId: TARGET,
          total: 3,
          open: 2,
          distinctReporters: 2,
          firstAt: NOW - 1000,
          lastAt: NOW,
          reports: [summary],
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });

    const result = await api().searchReports(
      GUILD,
      reportListQuerySchema.parse({ group: 'member', sort: 'volume' }),
      ACTOR,
    );

    expect(new URL(calls[0]?.url ?? '').searchParams.get('group')).toBe('member');
    expect(result.grouped ? result.groups[0]?.open : undefined).toBe(2);
  });

  test('a report missing a key is refused by name rather than read as undefined', async () => {
    const { status: _status, ...broken } = summary;
    answer(200, { grouped: false, reports: [broken], total: 1, page: 1, pageSize: 25 });

    await expect(api().searchReports(GUILD, query, ACTOR)).rejects.toThrow(
      /does not understand: reports\.0\.status: /,
    );
  });

  test('closing problems travel as close=problem, and nothing else takes that value', async () => {
    answer(200, { grouped: false, reports: [], total: 0, page: 1, pageSize: 25 });

    await api().searchReports(
      GUILD,
      reportListQuerySchema.parse({ status: 'all', close: 'problem' }),
      ACTOR,
    );

    expect(new URL(calls[0]?.url ?? '').searchParams.get('close')).toBe('problem');
    expect(reportListQuerySchema.safeParse({ close: 'late' }).success).toBe(false);
  });
});

describe('ApiClient report reads', () => {
  test('the summary', async () => {
    const counts = {
      counts: { open: 3, in_review: 1, accepted: 4, dismissed: 2 },
      openUnclaimed: 2,
      oldestOpenAt: NOW - 7_200_000,
      deliveryProblems: 1,
      closeProblems: 0,
      automationFailures7d: 0,
    };
    answer(200, counts);

    expect(await api().getReportSummary(GUILD, ACTOR)).toEqual(counts);
    expect(calls[0]?.url).toBe(
      `http://api.test/guilds/${GUILD}/moderation/reports/summary?viewerId=${ACTOR}`,
    );
  });

  test('a report, with its id escaped into the path and its timeline data kept as JSON', async () => {
    answer(200, detail);

    const report = await api().getReport(GUILD, 'a/b?c', ACTOR);

    expect(calls[0]?.url).toBe(
      `http://api.test/guilds/${GUILD}/moderation/reports/a%2Fb%3Fc?viewerId=${ACTOR}`,
    );
    expect(report.deciding).toBe(true);
    expect(report.comment).toBe('They keep posting invite links.');
    expect(report.events[0]?.data).toEqual({ method: 'message_menu', links: 0 });
  });

  test('an unknown report is the api’s own 404 sentence', async () => {
    answer(404, {
      error: 'not_found',
      message: `This server has no report \`${REPORT}\`. It may have been filed in another server.`,
    });

    const error = await refusal(() => api().getReport(GUILD, REPORT, ACTOR));

    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('This server has no report');
  });

  test('automation runs, filtered by status', async () => {
    answer(200, {
      runs: [
        {
          id: 'run1',
          ruleId: 'rule1',
          ruleName: 'Three reports in an hour',
          targetId: TARGET,
          episodeStart: NOW - 3_600_000,
          coveredUntil: NOW,
          reportIds: [REPORT],
          status: 'partial',
          outcomes: [
            {
              index: 0,
              kind: 'timeout',
              ok: false,
              code: 'skipped_recent_case',
              message: 'A recent case exists.',
              at: NOW,
            },
          ],
          createdAt: NOW,
          finishedAt: NOW,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 25,
    });

    const runs = await api().listReportAutomationRuns(
      GUILD,
      { status: 'partial', page: 1, pageSize: 25 },
      ACTOR,
    );
    const url = new URL(calls[0]?.url ?? '');

    expect(url.pathname).toBe(`/guilds/${GUILD}/moderation/reports/automation/runs`);
    expect(url.searchParams.get('status')).toBe('partial');
    expect(url.searchParams.get('viewerId')).toBe(ACTOR);
    expect(runs.runs[0]?.outcomes[0]?.code).toBe('skipped_recent_case');
  });

  test('failed-or-partial runs are one filter, problem', () => {
    expect(automationRunListQuerySchema.parse({ status: 'problem' }).status).toBe('problem');
    expect(automationRunListQuerySchema.parse({ status: '' }).status).toBeUndefined();
    expect(automationRunListQuerySchema.safeParse({ status: 'lost' }).success).toBe(false);
  });

  test('case evidence splits the proof from the history', async () => {
    const message = {
      caseId: CASE,
      messageId: '600000000000000009',
      channelId: '500000000000000001',
      authorId: TARGET,
      content: 'buy followers at',
      attachments: [
        {
          id: 'a1',
          filename: 'proof.png',
          contentType: 'image/png',
          size: 2048,
          url: 'https://cdn.discordapp.com/attachments/1/2/proof.png',
          expiresAt: NOW + 86_400_000,
        },
      ],
      createdAt: NOW - 60_000,
      deletedAt: NOW - 30_000,
      proof: true,
      capturedAt: NOW - 30_000,
      expiresAt: NOW + 30 * 86_400_000,
    };
    answer(200, { proof: message, history: [{ ...message, proof: false, attachments: [] }] });

    const evidence = await api().getCaseEvidence(GUILD, CASE);

    expect(calls[0]?.url).toBe(`http://api.test/guilds/${GUILD}/cases/${CASE}/evidence`);
    expect(evidence.proof?.attachments[0]?.filename).toBe('proof.png');
    expect(evidence.history).toHaveLength(1);
  });

  test('a case with nothing kept answers an empty history, not a 404', async () => {
    answer(200, { proof: null, history: [] });

    expect(await api().getCaseEvidence(GUILD, CASE)).toEqual({ proof: null, history: [] });
  });
});

describe('ApiClient.actOnReport', () => {
  const body = {
    action: 'accept' as const,
    params: { punishment: 'timeout' as const, duration: '1h', reason: 'Spam' },
    requestId: 'a1b2c3d4e5f60718',
    actorPermissions: '1099511627775',
    actorId: ACTOR,
    source: 'dashboard' as const,
    ipHash: 'abc',
  };

  test('posts the action with the audit stamp and reads back the worker’s outcome', async () => {
    answer(200, {
      ok: true,
      code: 'accepted',
      message: 'Report `Rk7f3M2q` accepted.',
      caseId: CASE,
    });

    const outcome = await api().actOnReport(GUILD, REPORT, body);

    expect(calls[0]?.url).toBe(
      `http://api.test/guilds/${GUILD}/moderation/reports/${REPORT}/actions`,
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(body);
    expect(outcome).toEqual({
      ok: true,
      code: 'accepted',
      message: 'Report `Rk7f3M2q` accepted.',
      caseId: CASE,
    });
  });

  test('a refusal from the worker is an answer, not an error', async () => {
    answer(200, {
      ok: false,
      code: 'self_review',
      message: 'You can’t review a report about yourself.',
    });

    const outcome = await api().actOnReport(GUILD, REPORT, body);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe('You can’t review a report about yourself.');
  });

  test('a recent case comes back as a question to confirm', async () => {
    answer(200, {
      ok: false,
      code: 'needs_confirmation',
      message: 'This member was timed out 10 minutes ago. Timeout them again?',
      needsConfirmation: 'recent_case',
    });

    expect((await api().actOnReport(GUILD, REPORT, body)).needsConfirmation).toBe('recent_case');
  });

  test('a worker that did not answer is a 409 that says the action may still land', async () => {
    answer(409, {
      error: 'worker_timeout',
      message:
        'The worker did not answer within 20 seconds. The action may still complete — refresh the ' +
        'report in a moment to see where it stands before trying again.',
    });

    const error = await refusal(() => api().actOnReport(GUILD, REPORT, body));

    expect(error.status).toBe(409);
    expect(error.code).toBe('worker_timeout');
    expect(error.message).toContain('The action may still complete');
  });

  test.each([
    ['no_redis', 'Proton cannot reach Redis, where the worker leaves its answer'],
    ['no_bus', 'Proton cannot reach its event bus'],
  ])('a 503 %s keeps its code and sentence', async (code, sentence) => {
    answer(503, { error: code, message: `${sentence}, so nothing was done.` });

    const error = await refusal(() => api().actOnReport(GUILD, REPORT, body));

    expect(error.status).toBe(503);
    expect(error.code).toBe(code);
    expect(error.message).toStartWith(sentence);
  });

  test('Moderation switched off is a 409 with the api’s wording', async () => {
    answer(409, {
      error: 'module_disabled',
      message: 'Moderation is turned off in this server, so nothing was done. Turn it on first.',
    });

    const error = await refusal(() => api().actOnReport(GUILD, REPORT, body));

    expect(error.code).toBe('module_disabled');
  });

  test('an answer that is not JSON keeps the neutral outage wording', async () => {
    answer(502, '<html>bad gateway</html>');

    const error = await refusal(() => api().actOnReport(GUILD, REPORT, body));

    expect(error.code).toBeUndefined();
    expect(error.message).toContain("Proton's API did not answer (HTTP 502)");
  });

  test('an outcome in a shape the dashboard does not know is refused', async () => {
    answer(200, { ok: 'yes' });

    await expect(api().actOnReport(GUILD, REPORT, body)).rejects.toThrow(/does not understand/);
  });
});
