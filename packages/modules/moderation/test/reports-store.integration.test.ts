import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DbHandle, guilds, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { DrizzleReportStore } from '../src/reports/postgres-store.ts';
import type { NewReport, SubmitLimits } from '../src/reports/store.ts';
import type { ReportEvidence, ReportRecord } from '../src/reports/types.ts';
import { reportEvents, reports } from '../src/tables.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleReportStore;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const REPORTER = '400000000000000003';
const TARGET = '400000000000000001';
const MODERATOR = '100000000000000001';
const NOW = Date.UTC(2026, 8, 18, 12, 0, 0, 123);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const LOOSE: SubmitLimits = {
  cooldownMs: 0,
  bypassCooldown: false,
  duplicateProtection: false,
  maxOpenPerMember: 100,
  maxOpenPerServer: 1000,
};

let sequence = 0;

function input(overrides: Partial<NewReport> = {}): NewReport {
  sequence += 1;
  return {
    guildId: GUILD,
    reporterId: REPORTER,
    targetId: TARGET,
    method: 'command',
    reasonId: 'spam',
    reason: 'Spam or flooding',
    customReason: 'custom words',
    comment: 'what happened',
    source: null,
    evidence: { links: [], attachments: [] },
    idempotencyKey: `interaction:${sequence}`,
    now: NOW,
    ...overrides,
  };
}

async function file(overrides: Partial<NewReport> = {}, limits = LOOSE): Promise<ReportRecord> {
  const result = await store.submit(input(overrides), limits);
  if (result.status !== 'filed') throw new Error(`expected filed, got ${result.status}`);
  return result.report;
}

async function decide(report: ReportRecord, token: string, at = NOW) {
  return store.beginDecision({
    guildId: GUILD,
    id: report.id,
    token,
    kind: 'ban',
    now: at,
    staleMs: 2 * MINUTE,
  });
}

function resolution(report: ReportRecord, token: string) {
  return {
    guildId: GUILD,
    id: report.id,
    status: 'accepted' as const,
    by: MODERATOR,
    at: NOW + MINUTE,
    note: 'internal',
    reporterNote: 'thanks',
    actionKind: 'ban',
    caseIds: ['CaseAAA', 'CaseBBB'],
    token,
    evidenceExpiresAt: NOW + MINUTE + 30 * DAY,
    close: { action: 'move' as const, dueAt: NOW + 2 * MINUTE },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleReportStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
});

describe('submit', () => {
  test('numbers per guild, keeps millisecond times and records the submitted event', async () => {
    const first = await file();
    const second = await file({ now: NOW + 1 });
    const elsewhere = await file({ guildId: OTHER_GUILD });

    expect([first.number, second.number, elsewhere.number]).toEqual([1, 2, 1]);
    expect(first.createdAt).toBe(NOW);
    expect(second.createdAt).toBe(NOW + 1);
    expect(first.evidenceExpiresAt).toBe(NOW + 90 * DAY);

    const events = await store.listEvents(GUILD, first.id);
    expect(events.map((event) => [event.id, event.kind, event.source])).toEqual([
      [`${first.id}:submitted`, 'submitted', 'discord'],
    ]);
  });

  test('an idempotency key replay returns the saved report', async () => {
    const payload = input();
    const first = await store.submit(payload, LOOSE);
    const again = await store.submit(payload, LOOSE);

    expect(again.status).toBe('existing');
    expect(again.status !== 'refused' && first.status !== 'refused' && again.report.id).toBe(
      first.status !== 'refused' ? first.report.id : '',
    );
  });

  test('cooldown, duplicate and caps refuse inside the lock', async () => {
    const source = {
      channelId: '500000000000000001',
      messageId: '1400000000000000001',
      authorId: TARGET,
    };
    const first = await file({ source });

    expect(
      await store.submit(input({ now: NOW + MINUTE }), { ...LOOSE, cooldownMs: 2 * MINUTE }),
    ).toEqual({ status: 'refused', code: 'cooldown', retryAt: NOW + 2 * MINUTE });
    expect(await store.submit(input({ source }), { ...LOOSE, duplicateProtection: true })).toEqual({
      status: 'refused',
      code: 'duplicate',
      reportId: first.id,
    });
    expect(await store.submit(input(), { ...LOOSE, maxOpenPerMember: 1 })).toEqual({
      status: 'refused',
      code: 'member_cap',
    });
    expect(
      await store.submit(input({ targetId: '400000000000000009' }), {
        ...LOOSE,
        maxOpenPerServer: 1,
      }),
    ).toEqual({ status: 'refused', code: 'server_cap' });
  });

  test('concurrent submissions are serialised by the advisory lock', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.submit(input({ reporterId: `4000000000000001${String(index).padStart(2, '0')}` }), {
          ...LOOSE,
          maxOpenPerServer: 4,
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'filed')).toHaveLength(4);

    const rows = await handle.db.select().from(reports).where(eq(reports.guildId, GUILD));
    expect(rows.map((row) => row.number).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('conditional updates', () => {
  test('two claims at once: exactly one wins', async () => {
    const report = await file();

    const [a, b] = await Promise.all([
      store.claim(GUILD, report.id, MODERATOR, NOW),
      store.claim(GUILD, report.id, REPORTER, NOW),
    ]);

    expect([a, b].filter((claimed) => claimed !== null)).toHaveLength(1);
    expect(await store.claim(GUILD, report.id, (a ?? b)?.assigneeId ?? '', NOW)).not.toBeNull();
  });

  test('decision tokens: held, stale takeover, resolve only with the token', async () => {
    const report = await file();

    expect(await decide(report, 'a')).toMatchObject({ state: 'acquired', takeover: null });
    expect(await decide(report, 'b', NOW + MINUTE)).toMatchObject({ state: 'held_by_other' });
    expect(await decide(report, 'b', NOW + 3 * MINUTE)).toMatchObject({
      state: 'acquired',
      takeover: { token: 'a', kind: 'ban' },
    });

    expect(await store.resolve(resolution(report, 'a'))).toBeNull();

    await store.linkCase(GUILD, report.id, 'CaseAAA');
    const resolved = await store.resolve(resolution(report, 'b'));
    expect(resolved).toMatchObject({
      status: 'accepted',
      caseIds: ['CaseAAA', 'CaseBBB'],
      evidenceExpiresAt: NOW + MINUTE + 30 * DAY,
      close: { action: 'move', dueAt: NOW + 2 * MINUTE },
      decision: { token: 'b', kind: 'ban' },
    });

    expect(await decide(report, 'b')).toMatchObject({ state: 'resolved', mine: true });
    expect(await decide(report, 'c')).toMatchObject({ state: 'resolved', mine: false });
  });

  test('release frees the decision only for its own token', async () => {
    const report = await file();
    await decide(report, 'a');

    await store.releaseDecision(GUILD, report.id, 'b');
    expect(await decide(report, 'b')).toMatchObject({ state: 'held_by_other' });

    await store.releaseDecision(GUILD, report.id, 'a');
    expect(await decide(report, 'b')).toMatchObject({ state: 'acquired', takeover: null });
  });

  test('a card is marked missing only while it is the posted card', async () => {
    const report = await file();
    await store.rememberCard(GUILD, report.id, {
      channelId: '500000000000000009',
      messageId: '1400000000000000050',
    });

    expect(
      await store.markCard(GUILD, report.id, 'missing', { messageId: '1400000000000000051' }),
    ).toBeNull();
    expect(
      await store.markCard(GUILD, report.id, 'missing', { messageId: '1400000000000000050' }),
    ).toMatchObject({ card: { state: 'missing' } });
  });

  test('evidence copy and notifications are merged into jsonb', async () => {
    const report = await file();

    await store.rememberEvidenceCopy(GUILD, report.id, {
      channelId: '500000000000000009',
      messageId: '1400000000000000060',
    });
    await store.recordNotification(GUILD, report.id, 'submitted', 'sent', NOW);
    await store.recordNotification(GUILD, report.id, 'accepted', 'closed', NOW + 1);

    expect(await store.get(GUILD, report.id)).toMatchObject({
      evidence: { copy: { messageId: '1400000000000000060' } },
      card: { evidenceMessageId: '1400000000000000060' },
      notifications: {
        submitted: { outcome: 'sent', at: NOW },
        accepted: { outcome: 'closed', at: NOW + 1 },
      },
    });
  });
});

describe('automation', () => {
  const statuses = ['open', 'in_review'] as const;

  async function evaluate(ruleId: string, minimum: number, at: number) {
    const last = await store.lastRun(GUILD, ruleId, TARGET);
    const rows = await store.qualifying(GUILD, TARGET, {
      since: at - DAY,
      lastRun: last ? { coveredUntil: last.coveredUntil, reportIds: last.reportIds } : null,
      statuses,
      uncoveredBy: ruleId,
    });
    if (rows.length < minimum) return null;

    return store.claimRun({
      id: `run-${ruleId}-${at}`,
      guildId: GUILD,
      ruleId,
      ruleName: ruleId,
      targetId: TARGET,
      episodeStart: last ? Math.max(last.coveredUntil, last.episodeStart + 1) : 0,
      reportIds: rows.map((row) => row.id),
      now: at,
      leaseMs: 2 * MINUTE,
    });
  }

  test('covered_until comes from the reports, and a rule fires once per episode', async () => {
    await file({ reporterId: '400000000000000101' });
    await file({ reporterId: '400000000000000102', now: NOW + 7 });

    const run = await evaluate('several', 2, NOW + MINUTE);
    expect(run?.coveredUntil).toBe(NOW + 7);
    expect(await evaluate('several', 2, NOW + 2 * MINUTE)).toBeNull();

    await file({ reporterId: '400000000000000103', now: NOW + 7 });
    expect(await evaluate('several', 2, NOW + 3 * MINUTE)).toBeNull();
    expect(await evaluate('once', 1, NOW + 3 * MINUTE)).not.toBeNull();
  });

  test('a one-report rule fires exactly once across three evaluations', async () => {
    await file();

    const runs = [
      await evaluate('single', 1, NOW + MINUTE),
      await evaluate('single', 1, NOW + 2 * MINUTE),
      await evaluate('single', 1, NOW + 3 * MINUTE),
    ];

    expect(runs.filter((run) => run !== null)).toHaveLength(1);
  });

  test('reports sharing the last episode’s millisecond neither wedge the rule nor count twice', async () => {
    const r1 = await file({ reporterId: '400000000000000201', now: NOW + 7 });
    expect((await evaluate('every', 1, NOW + MINUTE))?.reportIds).toEqual([r1.id]);

    const r2 = await file({ reporterId: '400000000000000202', now: NOW + 7 });
    const second = await evaluate('every', 1, NOW + 2 * MINUTE);
    expect(second?.reportIds).toEqual([r2.id]);
    expect(second?.episodeStart).toBe(NOW + 7);

    const r3 = await file({ reporterId: '400000000000000203', now: NOW + 3 * MINUTE });
    const third = await evaluate('every', 1, NOW + 4 * MINUTE);
    expect(third?.reportIds).toEqual([r3.id]);
    expect(third?.episodeStart).toBe(NOW + 8);
  });

  test('the same episode cannot be claimed twice', async () => {
    const report = await file();
    const claim = (id: string) =>
      store.claimRun({
        id,
        guildId: GUILD,
        ruleId: 'r',
        ruleName: 'R',
        targetId: TARGET,
        episodeStart: 0,
        reportIds: [report.id],
        now: NOW,
        leaseMs: 2 * MINUTE,
      });

    const [a, b] = await Promise.all([claim('run-a'), claim('run-b')]);
    expect([a, b].filter((run) => run !== null)).toHaveLength(1);
  });

  test('leases: stale runs are resumed by one worker and outcomes are kept once', async () => {
    const report = await file();
    await store.claimRun({
      id: 'run-1',
      guildId: GUILD,
      ruleId: 'r',
      ruleName: 'R',
      targetId: TARGET,
      episodeStart: 0,
      reportIds: [report.id],
      now: NOW,
      leaseMs: 2 * MINUTE,
    });

    expect(await store.staleRuns(GUILD, NOW + MINUTE, 10)).toEqual([]);
    expect(await store.staleRuns(GUILD, NOW + 3 * MINUTE, 10)).toHaveLength(1);

    const resumed = await Promise.all([
      store.resumeRun(GUILD, 'run-1', NOW + 3 * MINUTE, 2 * MINUTE),
      store.resumeRun(GUILD, 'run-1', NOW + 3 * MINUTE, 2 * MINUTE),
    ]);
    expect(resumed.filter((run) => run !== null)).toHaveLength(1);

    const outcome = {
      index: 0,
      kind: 'alert',
      ok: true,
      code: 'sent',
      message: 'Alert sent.',
      at: NOW,
    };
    await store.recordRunOutcome(GUILD, 'run-1', outcome);
    await store.recordRunOutcome(GUILD, 'run-1', { ...outcome, message: 'again' });
    await store.finishRun(GUILD, 'run-1', 'done', NOW + 4 * MINUTE);

    expect(await store.lastRun(GUILD, 'r', TARGET)).toMatchObject({
      status: 'done',
      outcomes: [outcome],
      finishedAt: NOW + 4 * MINUTE,
    });
  });

  test('stats and targets waiting unclaimed', async () => {
    await file({ reporterId: '400000000000000101' });
    await file({ reporterId: '400000000000000102', now: NOW + MINUTE });

    expect(await store.targetStats(GUILD, TARGET, NOW)).toEqual({
      total: 2,
      distinctReporters: 2,
      open: 2,
    });
    expect(await store.targetsWithOpenUnclaimed(GUILD, NOW + 1, 50, null)).toEqual([TARGET]);
    expect(await store.targetsWithOpenUnclaimed(GUILD, NOW, 50, null)).toEqual([]);
    expect(await store.targetsWithOpenUnclaimed(GUILD, NOW + 1, 50, TARGET)).toEqual([]);
  });
});

describe('patrol queries and retention', () => {
  test('delivery backlog honours the backoff and the attempt limit', async () => {
    const report = await file();
    await handle.db
      .update(reports)
      .set({ updatedAt: new Date(NOW) })
      .where(eq(reports.id, report.id));

    expect(await store.deliveryBacklog(GUILD, NOW, 10)).toEqual([]);
    expect(await store.deliveryBacklog(GUILD, NOW + MINUTE, 10)).toHaveLength(1);

    for (let attempt = 1; attempt <= 5; attempt += 1) await store.noteCardAttempt(GUILD, report.id);
    expect(await store.deliveryBacklog(GUILD, NOW + 10 * DAY, 10)).toEqual([]);
  });

  test('due closes and unfinished resolutions', async () => {
    const report = await file();
    await store.rememberCard(GUILD, report.id, {
      channelId: '500000000000000009',
      messageId: '1400000000000000070',
    });
    await decide(report, 'a');
    const resolved = await store.resolve(resolution(report, 'a'));

    expect(await store.dueCloses(GUILD, NOW + MINUTE, 10)).toEqual([]);
    expect(await store.dueCloses(GUILD, NOW + 2 * MINUTE, 10)).toHaveLength(1);

    expect(await store.unfinishedResolutions(GUILD, 10)).toHaveLength(1);
    await store.markCardVersion(GUILD, report.id, resolved?.version ?? 0);
    await store.recordNotification(GUILD, report.id, 'accepted', 'sent', NOW);
    expect(await store.unfinishedResolutions(GUILD, 10)).toEqual([]);

    const moved = await store.moveCard(
      GUILD,
      report.id,
      {
        channelId: '500000000000000010',
        messageId: '1400000000000000071',
        copy: { channelId: '500000000000000010', messageId: '1400000000000000072' },
      },
      'closing',
    );
    expect(moved?.evidence.copy).toEqual({
      channelId: '500000000000000010',
      messageId: '1400000000000000072',
    });
    expect(moved?.card.evidenceMessageId).toBe('1400000000000000072');

    expect(await store.markClosed(GUILD, report.id, 'moved', NOW + 3 * MINUTE)).toMatchObject({
      card: { state: 'moved', messageId: '1400000000000000071' },
    });
    expect(await store.dueCloses(GUILD, NOW + DAY, 10)).toEqual([]);
  });

  test('the purge empties evidence and reporter text, keeps the record, and runs once', async () => {
    const evidence: ReportEvidence = {
      message: {
        status: 'captured',
        snapshot: {
          id: '1400000000000000001',
          channelId: '500000000000000001',
          authorId: TARGET,
          authorName: 'member',
          authorBot: false,
          url: 'https://discord.com/channels/1/2/3',
          createdAt: NOW,
          editedAt: null,
          content: 'secret words',
          attachments: [],
          embeds: [],
          stickers: [],
          forwarded: false,
          forwardedContent: null,
          capturedFrom: 'interaction',
        },
      },
      links: [{ url: 'https://discord.com/channels/1/2/4', status: 'no_access' }],
      attachments: [
        {
          id: '1',
          filename: 'a.png',
          contentType: 'image/png',
          size: 1,
          url: 'https://x',
          expiresAt: null,
        },
      ],
      copy: { channelId: '500000000000000009', messageId: '1400000000000000080' },
    };
    const report = await file({ evidence });

    expect(await store.purgeExpiredEvidence(NOW + 89 * DAY, 10)).toBe(0);
    expect(await store.purgeExpiredEvidence(NOW + 90 * DAY, 10)).toBe(1);
    expect(await store.purgeExpiredEvidence(NOW + 91 * DAY, 10)).toBe(0);

    const purged = await store.get(GUILD, report.id);
    expect(purged).toMatchObject({
      comment: null,
      customReason: null,
      reporterNote: null,
      reason: 'Spam or flooding',
      evidencePurgedAt: NOW + 90 * DAY,
      evidence: {
        purged: true,
        attachments: [],
        links: [{ url: 'https://discord.com/channels/1/2/4', status: 'no_access' }],
        message: {
          status: 'unavailable',
          reason: 'purged',
          ids: { channelId: '500000000000000001', messageId: '1400000000000000001' },
        },
        copy: { channelId: '500000000000000009', messageId: '1400000000000000080' },
      },
    });
    expect(JSON.stringify(purged?.evidence)).not.toContain('secret words');

    const events = await handle.db
      .select()
      .from(reportEvents)
      .where(eq(reportEvents.reportId, report.id));
    expect(events.map((event) => event.kind).sort()).toEqual(['evidence_purged', 'submitted']);
  });

  test('a reporter note written after the purge is purged on the next run', async () => {
    const report = await file();
    expect(await store.purgeExpiredEvidence(NOW + 90 * DAY, 10)).toBe(1);

    await decide(report, 'late', NOW + 95 * DAY);
    const resolved = await store.resolve({
      ...resolution(report, 'late'),
      at: NOW + 95 * DAY,
      evidenceExpiresAt: NOW + 125 * DAY,
    });
    expect(resolved?.reporterNote).toBe('thanks');

    expect(await store.purgeExpiredEvidence(NOW + 95 * DAY + MINUTE, 10)).toBe(1);
    expect(await store.get(GUILD, report.id)).toMatchObject({
      reporterNote: null,
      resolutionNote: 'internal',
      evidence: { purged: true },
    });
  });

  test('failed card edits cap out of unfinished resolutions and closes cap out of due closes', async () => {
    const report = await file();
    await store.rememberCard(GUILD, report.id, {
      channelId: '500000000000000009',
      messageId: '1400000000000000070',
    });
    await decide(report, 'a');
    await store.resolve(resolution(report, 'a'));
    await store.recordNotification(GUILD, report.id, 'accepted', 'sent', NOW);

    for (let n = 0; n < 4; n += 1) await store.noteCardEditFailure(GUILD, report.id);
    expect(await store.unfinishedResolutions(GUILD, 10)).toHaveLength(1);
    await store.noteCardEditFailure(GUILD, report.id);
    expect(await store.unfinishedResolutions(GUILD, 10)).toEqual([]);

    expect(await store.dueCloses(GUILD, NOW + DAY, 10)).toHaveLength(1);
    for (let n = 0; n < 10; n += 1) await store.noteCloseAttempt(GUILD, report.id);
    expect(await store.dueCloses(GUILD, NOW + DAY, 10)).toEqual([]);
  });
});
