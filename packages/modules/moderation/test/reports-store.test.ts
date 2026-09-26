import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { DRAFT_ID_PATTERN, newDraftId, RedisDraftStore } from '../src/drafts.ts';
import { RedisPromptStore, RedisReactionGate } from '../src/reports/redis-store.ts';
import type { NewReport, SubmitLimits } from '../src/reports/store.ts';
import { EVIDENCE_OPEN_TTL_MS } from '../src/reports/types.ts';
import { GUILD, MEMBER, MODERATOR, REPORTER } from './harness.ts';
import { MemoryDraftStore, MemoryReportStore } from './reports-memory-store.ts';

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const OTHER_GUILD = '900000000000000002';
const TARGET_B = '400000000000000009';

const LOOSE: SubmitLimits = {
  cooldownMs: 0,
  bypassCooldown: false,
  duplicateProtection: false,
  maxOpenPerMember: 100,
  maxOpenPerServer: 1000,
};

let sequence = 0;

function report(overrides: Partial<NewReport> = {}): NewReport {
  sequence += 1;
  return {
    guildId: GUILD,
    reporterId: REPORTER,
    targetId: MEMBER,
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

function clock(start = NOW) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

async function filed(store: MemoryReportStore, input: NewReport, limits = LOOSE) {
  const result = await store.submit(input, limits);
  if (result.status !== 'filed') throw new Error(`expected a filed report, got ${result.status}`);
  return result.report;
}

describe('submit', () => {
  test('numbers reports per server and keeps evidence for 90 days', async () => {
    const store = new MemoryReportStore();

    const first = await filed(store, report());
    const second = await filed(store, report());
    const elsewhere = await filed(store, report({ guildId: OTHER_GUILD }));

    expect([first.number, second.number, elsewhere.number]).toEqual([1, 2, 1]);
    expect(first.id).toMatch(/^[A-Za-z0-9]{7}$/);
    expect(first.evidenceExpiresAt).toBe(NOW + EVIDENCE_OPEN_TTL_MS);
    expect(first.card.state).toBe('pending');
    expect(await store.listEvents(GUILD, first.id)).toEqual([
      expect.objectContaining({ kind: 'submitted', id: `${first.id}:submitted` }),
    ]);
  });

  test('the same idempotency key answers with the saved report', async () => {
    const store = new MemoryReportStore();
    const input = report();

    const first = await store.submit(input, LOOSE);
    const again = await store.submit({ ...input, comment: 'changed' }, LOOSE);

    expect(again.status).toBe('existing');
    expect(again.status !== 'refused' && again.report.id).toBe(
      first.status !== 'refused' ? first.report.id : '',
    );
    expect(store.rows.size).toBe(1);
  });

  test('a cooldown refuses until it passes and names the time', async () => {
    const store = new MemoryReportStore();
    const limits = { ...LOOSE, cooldownMs: 2 * MINUTE };
    await filed(store, report(), limits);

    const early = await store.submit(report({ now: NOW + MINUTE }), limits);
    expect(early).toEqual({ status: 'refused', code: 'cooldown', retryAt: NOW + 2 * MINUTE });

    const bypassed = await store.submit(report({ now: NOW + MINUTE }), {
      ...limits,
      bypassCooldown: true,
    });
    expect(bypassed.status).toBe('filed');

    const later = await store.submit(report({ now: NOW + 5 * MINUTE }), limits);
    expect(later.status).toBe('filed');
  });

  test('duplicates are the same reporter, member and source message while open', async () => {
    const store = new MemoryReportStore();
    const limits = { ...LOOSE, duplicateProtection: true };
    const source = {
      channelId: '500000000000000001',
      messageId: '1400000000000000001',
      authorId: MEMBER,
    };

    const first = await filed(store, report({ source }), limits);

    expect(await store.submit(report({ source }), limits)).toEqual({
      status: 'refused',
      code: 'duplicate',
      reportId: first.id,
    });
    expect((await store.submit(report(), limits)).status).toBe('filed');
    expect(
      (
        await store.submit(
          report({ source: { ...source, messageId: '1400000000000000002' } }),
          limits,
        )
      ).status,
    ).toBe('filed');
    expect((await store.submit(report({ source, reporterId: MODERATOR }), limits)).status).toBe(
      'filed',
    );
  });

  test('caps count only open reports', async () => {
    const store = new MemoryReportStore();
    const limits = { ...LOOSE, maxOpenPerMember: 1, maxOpenPerServer: 2 };

    const first = await filed(store, report(), limits);
    expect((await store.submit(report(), limits)).status).toBe('refused');
    expect(await store.submit(report(), limits)).toEqual({ status: 'refused', code: 'member_cap' });

    await filed(store, report({ targetId: TARGET_B }), limits);
    expect(await store.submit(report({ targetId: '400000000000000010' }), limits)).toEqual({
      status: 'refused',
      code: 'server_cap',
    });

    await store.beginDecision({
      guildId: GUILD,
      id: first.id,
      token: 't',
      kind: 'dismiss',
      now: NOW,
      staleMs: 2 * MINUTE,
    });
    await store.resolve({
      guildId: GUILD,
      id: first.id,
      status: 'dismissed',
      by: MODERATOR,
      at: NOW,
      note: null,
      reporterNote: null,
      actionKind: null,
      caseIds: [],
      token: 't',
      evidenceExpiresAt: NOW + 30 * DAY,
      close: { action: null, dueAt: null },
    });

    expect((await store.submit(report(), limits)).status).toBe('filed');
  });

  test('concurrent submissions cannot pass a cap together', async () => {
    const store = new MemoryReportStore();
    const limits = { ...LOOSE, maxOpenPerServer: 3 };

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.submit(
          report({ reporterId: `4000000000000001${String(index).padStart(2, '0')}` }),
          limits,
        ),
      ),
    );

    expect(results.filter((result) => result.status === 'filed')).toHaveLength(3);
    expect(results.filter((result) => result.status === 'refused')).toHaveLength(5);
    expect(new Set([...store.rows.values()].map((row) => row.number))).toEqual(new Set([1, 2, 3]));
  });

  test('an id collision is retried with a fresh id, and five in a row give up', async () => {
    const store = new MemoryReportStore();
    const taken = await filed(store, report());

    const ids = [taken.id, taken.id, 'Fresh01'];
    store.mintId = () => ids.shift() ?? 'Fresh02';
    expect((await filed(store, report())).id).toBe('Fresh01');

    store.mintId = () => taken.id;
    await expect(store.submit(report(), LOOSE)).rejects.toThrow('could not mint');
  });
});

describe('claiming', () => {
  test('the first claim wins; the loser is told by a null; the holder may re-claim', async () => {
    const store = new MemoryReportStore();
    const open = await filed(store, report());

    const mine = await store.claim(GUILD, open.id, MODERATOR, NOW);
    expect(mine).toMatchObject({ status: 'in_review', assigneeId: MODERATOR, version: 1 });

    expect(await store.claim(GUILD, open.id, REPORTER, NOW)).toBeNull();

    const again = await store.claim(GUILD, open.id, MODERATOR, NOW + MINUTE);
    expect(again).toMatchObject({ version: 1, assignedAt: NOW });
  });

  test('unclaim reopens; assign hands it to someone else or back to nobody', async () => {
    const store = new MemoryReportStore();
    const open = await filed(store, report());
    await store.claim(GUILD, open.id, MODERATOR, NOW);

    expect(await store.unclaim(GUILD, open.id, NOW)).toMatchObject({
      status: 'open',
      assigneeId: null,
    });
    expect(await store.unclaim(GUILD, open.id, NOW)).toBeNull();

    expect(await store.assign(GUILD, open.id, REPORTER, NOW)).toMatchObject({
      status: 'in_review',
      assigneeId: REPORTER,
    });
    expect(await store.assign(GUILD, open.id, null, NOW)).toMatchObject({
      status: 'open',
      assigneeId: null,
    });
  });
});

describe('decisions', () => {
  async function decided() {
    const store = new MemoryReportStore();
    const open = await filed(store, report());
    const begin = (token: string, now = NOW) =>
      store.beginDecision({
        guildId: GUILD,
        id: open.id,
        token,
        kind: 'ban',
        now,
        staleMs: 2 * MINUTE,
      });
    return { store, open, begin };
  }

  test('one token holds a report; another is turned away until it goes stale', async () => {
    const { begin } = await decided();

    expect(await begin('a')).toMatchObject({ state: 'acquired', mine: true, takeover: null });
    expect(await begin('a')).toMatchObject({ state: 'acquired', mine: true });
    expect(await begin('b', NOW + MINUTE)).toMatchObject({ state: 'held_by_other', mine: false });

    const taken = await begin('b', NOW + 3 * MINUTE);
    expect(taken).toMatchObject({ state: 'acquired', takeover: { token: 'a', kind: 'ban' } });
  });

  test('resolve needs the holding token, keeps it, and merges case ids', async () => {
    const { store, open, begin } = await decided();
    await begin('a');
    await store.linkCase(GUILD, open.id, 'CaseAAA');

    const input = {
      guildId: GUILD,
      id: open.id,
      status: 'accepted' as const,
      by: MODERATOR,
      at: NOW + MINUTE,
      note: 'internal',
      reporterNote: 'thanks',
      actionKind: 'ban',
      caseIds: ['CaseAAA', 'CaseBBB'],
      evidenceExpiresAt: NOW + MINUTE + 30 * DAY,
      close: { action: 'move' as const, dueAt: NOW + 2 * MINUTE },
    };

    expect(await store.resolve({ ...input, token: 'b' })).toBeNull();

    const resolved = await store.resolve({ ...input, token: 'a' });
    expect(resolved).toMatchObject({
      status: 'accepted',
      caseIds: ['CaseAAA', 'CaseBBB'],
      evidenceExpiresAt: NOW + MINUTE + 30 * DAY,
      close: { action: 'move', dueAt: NOW + 2 * MINUTE },
      decision: { token: 'a' },
    });

    expect(await begin('a')).toMatchObject({ state: 'resolved', mine: true });
    expect(await begin('c')).toMatchObject({ state: 'resolved', mine: false });
    expect(await store.resolve({ ...input, token: 'a' })).toBeNull();
  });

  test('evidence expiry only ever moves earlier', async () => {
    const { store, open, begin } = await decided();
    await begin('a');

    const resolved = await store.resolve({
      guildId: GUILD,
      id: open.id,
      status: 'dismissed',
      by: MODERATOR,
      at: NOW,
      note: null,
      reporterNote: null,
      actionKind: null,
      caseIds: [],
      token: 'a',
      evidenceExpiresAt: NOW + 200 * DAY,
      close: { action: null, dueAt: null },
    });

    expect(resolved?.evidenceExpiresAt).toBe(NOW + EVIDENCE_OPEN_TTL_MS);
  });

  test('release frees the report for another decision', async () => {
    const { store, open, begin } = await decided();
    await begin('a');
    await store.releaseDecision(GUILD, open.id, 'b');
    expect(await begin('b')).toMatchObject({ state: 'held_by_other' });

    await store.releaseDecision(GUILD, open.id, 'a');
    expect(await begin('b')).toMatchObject({ state: 'acquired', takeover: null });
  });

  test('a missing report says so', async () => {
    const store = new MemoryReportStore();
    expect(
      await store.beginDecision({
        guildId: GUILD,
        id: 'Nope000',
        token: 'a',
        kind: 'ban',
        now: NOW,
        staleMs: MINUTE,
      }),
    ).toMatchObject({ state: 'missing', report: null });
  });

  test('linkCase appends once and bumps the version once', async () => {
    const { store, open } = await decided();

    await store.linkCase(GUILD, open.id, 'CaseAAA');
    const twice = await store.linkCase(GUILD, open.id, 'CaseAAA');

    expect(twice).toMatchObject({ caseIds: ['CaseAAA'], version: 1 });
  });
});

describe('the staff card', () => {
  test('missing is recorded only for the posted card it names', async () => {
    const store = new MemoryReportStore();
    const open = await filed(store, report());
    await store.rememberCard(GUILD, open.id, {
      channelId: '500000000000000009',
      messageId: '1400000000000000050',
    });

    expect(
      await store.markCard(GUILD, open.id, 'missing', { messageId: '1400000000000000051' }),
    ).toBeNull();
    expect(await store.markCard(GUILD, open.id, 'missing')).toBeNull();
    expect(
      await store.markCard(GUILD, open.id, 'missing', { messageId: '1400000000000000050' }),
    ).toMatchObject({ card: { state: 'missing' } });
    expect(await store.byCardMessage(GUILD, '1400000000000000050')).toMatchObject({ id: open.id });
  });

  test('delivery backlog backs off by attempts and stops at five', async () => {
    const time = clock();
    const store = new MemoryReportStore(time.now);
    const open = await filed(store, report());

    expect(await store.deliveryBacklog(GUILD, NOW, 10)).toEqual([]);
    expect(await store.deliveryBacklog(GUILD, NOW + MINUTE, 10)).toHaveLength(1);

    expect(await store.noteCardAttempt(GUILD, open.id)).toBe(1);
    await store.markCard(GUILD, open.id, 'failed', { error: 'Missing Access' });
    expect(await store.deliveryBacklog(GUILD, NOW + MINUTE, 10)).toEqual([]);
    expect(await store.deliveryBacklog(GUILD, NOW + 2 * MINUTE, 10)).toHaveLength(1);

    for (let attempt = 2; attempt <= 5; attempt += 1) await store.noteCardAttempt(GUILD, open.id);
    expect(await store.deliveryBacklog(GUILD, NOW + DAY, 10)).toEqual([]);
  });

  test('the evidence copy is kept with its message id', async () => {
    const store = new MemoryReportStore();
    const open = await filed(store, report());

    await store.rememberEvidenceCopy(GUILD, open.id, {
      channelId: '500000000000000009',
      messageId: '1400000000000000060',
    });

    expect(await store.get(GUILD, open.id)).toMatchObject({
      evidence: { copy: { messageId: '1400000000000000060' } },
      card: { evidenceMessageId: '1400000000000000060' },
    });
  });
});

describe('automation queries', () => {
  test('qualifying excludes what the previous run covered, even in the same millisecond', async () => {
    const time = clock();
    const store = new MemoryReportStore(time.now);

    const a = await filed(store, report({ reporterId: '400000000000000101' }));
    const b = await filed(store, report({ reporterId: '400000000000000102', now: NOW + 5 }));
    const statuses = ['open', 'in_review'] as const;

    const before = await store.qualifying(GUILD, MEMBER, { since: 0, lastRun: null, statuses });
    expect(before.map((row) => row.id)).toEqual([a.id, b.id]);

    const run = await store.claimRun({
      id: 'run-1',
      guildId: GUILD,
      ruleId: 'several',
      ruleName: 'Several',
      targetId: MEMBER,
      episodeStart: 0,
      reportIds: [a.id, b.id],
      now: NOW + 10,
      leaseMs: 2 * MINUTE,
    });
    expect(run?.coveredUntil).toBe(NOW + 5);

    const lastRun = { coveredUntil: NOW + 5, reportIds: [a.id, b.id] };
    expect(await store.qualifying(GUILD, MEMBER, { since: 0, lastRun, statuses })).toEqual([]);

    const same = await filed(store, report({ reporterId: '400000000000000103', now: NOW + 5 }));
    const after = await store.qualifying(GUILD, MEMBER, { since: 0, lastRun, statuses });
    expect(after.map((row) => row.id)).toEqual([same.id]);

    expect(
      await store.claimRun({
        id: 'run-2',
        guildId: GUILD,
        ruleId: 'several',
        ruleName: 'Several',
        targetId: MEMBER,
        episodeStart: 0,
        reportIds: [same.id],
        now: NOW + 20,
        leaseMs: 2 * MINUTE,
      }),
    ).toBeNull();
  });

  test('stats, open unclaimed targets and statuses', async () => {
    const store = new MemoryReportStore();
    const a = await filed(store, report({ reporterId: '400000000000000101' }));
    await filed(store, report({ reporterId: '400000000000000102', now: NOW + MINUTE }));
    await filed(store, report({ reporterId: '400000000000000102', targetId: TARGET_B }));
    await store.claim(GUILD, a.id, MODERATOR, NOW);

    expect(await store.targetStats(GUILD, MEMBER, NOW)).toEqual({
      total: 2,
      distinctReporters: 2,
      open: 2,
    });
    expect(await store.targetStats(GUILD, MEMBER, NOW + 30_000)).toMatchObject({ total: 1 });
    expect(await store.targetsWithOpenUnclaimed(GUILD, NOW + 2 * MINUTE, 50, null)).toEqual(
      [MEMBER, TARGET_B].sort(),
    );
    expect(await store.targetsWithOpenUnclaimed(GUILD, NOW + 1, 50, null)).toEqual([TARGET_B]);
  });

  test('open unclaimed targets come in pages ordered by id, after a cursor', async () => {
    const store = new MemoryReportStore();
    const targets = Array.from(
      { length: 51 },
      (_, n) => `4100000000000${String(n).padStart(5, '0')}`,
    );
    for (const targetId of [...targets].reverse()) await filed(store, report({ targetId }));

    const first = await store.targetsWithOpenUnclaimed(GUILD, NOW + 1, 50, null);
    expect(first).toEqual(targets.slice(0, 50));

    const rest = await store.targetsWithOpenUnclaimed(GUILD, NOW + 1, 50, first.at(-1) ?? null);
    expect(rest).toEqual(targets.slice(50));
  });

  test('a run whose reports share the last episode’s millisecond does not wedge the rule', async () => {
    const store = new MemoryReportStore();
    const statuses = ['open', 'in_review'] as const;
    const at = NOW + 7;

    const evaluate = async (id: string) => {
      const last = await store.lastRun(GUILD, 'every', MEMBER);
      const rows = await store.qualifying(GUILD, MEMBER, {
        since: 0,
        lastRun: last ? { coveredUntil: last.coveredUntil, reportIds: last.reportIds } : null,
        statuses: [...statuses],
        uncoveredBy: 'every',
      });
      if (rows.length === 0) return { run: null, rows: [] as string[] };

      const run = await store.claimRun({
        id,
        guildId: GUILD,
        ruleId: 'every',
        ruleName: 'Every report',
        targetId: MEMBER,
        episodeStart: last ? Math.max(last.coveredUntil, last.episodeStart + 1) : 0,
        reportIds: rows.map((row) => row.id),
        now: NOW + MINUTE,
        leaseMs: MINUTE,
      });
      return { run, rows: rows.map((row) => row.id) };
    };

    const r1 = await filed(store, report({ reporterId: '400000000000000201', now: at }));
    expect((await evaluate('run-1')).rows).toEqual([r1.id]);

    const r2 = await filed(store, report({ reporterId: '400000000000000202', now: at }));
    const second = await evaluate('run-2');
    expect(second.rows).toEqual([r2.id]);
    expect(second.run?.episodeStart).toBe(at);
    expect(second.run?.coveredUntil).toBe(at);

    const r3 = await filed(store, report({ reporterId: '400000000000000203', now: at + MINUTE }));
    const third = await evaluate('run-3');
    expect(third.rows).toEqual([r3.id]);
    expect(third.run).not.toBeNull();
    expect(third.run?.episodeStart).toBe(at + 1);
  });

  test('a run lease: renewed while held, resumed once after it lapses', async () => {
    const store = new MemoryReportStore();
    const a = await filed(store, report());
    await store.claimRun({
      id: 'run-1',
      guildId: GUILD,
      ruleId: 'r',
      ruleName: 'R',
      targetId: MEMBER,
      episodeStart: 0,
      reportIds: [a.id],
      now: NOW,
      leaseMs: 2 * MINUTE,
    });

    expect(await store.staleRuns(GUILD, NOW + MINUTE, 10)).toEqual([]);
    expect(await store.renewLease(GUILD, 'run-1', NOW + 3 * MINUTE)).toBe(true);
    expect(await store.staleRuns(GUILD, NOW + 4 * MINUTE, 10)).toHaveLength(1);

    const [first, second] = await Promise.all([
      store.resumeRun(GUILD, 'run-1', NOW + 4 * MINUTE, 2 * MINUTE),
      store.resumeRun(GUILD, 'run-1', NOW + 4 * MINUTE, 2 * MINUTE),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

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
    await store.finishRun(GUILD, 'run-1', 'done', NOW + 5 * MINUTE);

    expect(await store.lastRun(GUILD, 'r', MEMBER)).toMatchObject({
      status: 'done',
      outcomes: [outcome],
      finishedAt: NOW + 5 * MINUTE,
    });
    expect(await store.renewLease(GUILD, 'run-1', NOW + DAY)).toBe(false);
  });
});

describe('closing and retention', () => {
  test('due closes and closing a card once', async () => {
    const store = new MemoryReportStore();
    const open = await filed(store, report());
    await store.scheduleClose(GUILD, open.id, 'delete', NOW + MINUTE);

    expect(await store.dueCloses(GUILD, NOW, 10)).toEqual([]);
    expect(await store.dueCloses(GUILD, NOW + MINUTE, 10)).toHaveLength(1);
    expect(await store.noteCloseAttempt(GUILD, open.id)).toBe(1);

    expect(await store.markClosed(GUILD, open.id, 'deleted', NOW + MINUTE)).toMatchObject({
      card: { state: 'deleted' },
      close: { closedAt: NOW + MINUTE },
    });
    expect(await store.markClosed(GUILD, open.id, 'deleted', NOW + 2 * MINUTE)).toBeNull();
    expect(await store.dueCloses(GUILD, NOW + DAY, 10)).toEqual([]);
  });

  test('due closes leave out reports that used up their attempts', async () => {
    const store = new MemoryReportStore();
    const spent = await filed(store, report());
    const due = await filed(store, report({ now: NOW + MINUTE }));
    await store.scheduleClose(GUILD, spent.id, 'delete', NOW);
    await store.scheduleClose(GUILD, due.id, 'delete', NOW + MINUTE);
    for (let n = 0; n < 10; n += 1) await store.noteCloseAttempt(GUILD, spent.id);

    expect((await store.dueCloses(GUILD, NOW + DAY, 1)).map((row) => row.id)).toEqual([due.id]);
  });

  test('moving a card rewrites the card refs and the evidence copy together', async () => {
    const store = new MemoryReportStore();
    const open = await filed(
      store,
      report({
        evidence: {
          links: [],
          attachments: [],
          copy: { channelId: '500000000000000009', messageId: '1400000000000000080' },
        },
      }),
    );

    const moved = await store.moveCard(
      GUILD,
      open.id,
      {
        channelId: '500000000000000011',
        messageId: '1400000000000000090',
        copy: { channelId: '500000000000000011', messageId: '1400000000000000091' },
      },
      'closing',
    );

    expect(moved?.card).toMatchObject({
      channelId: '500000000000000011',
      messageId: '1400000000000000090',
      evidenceMessageId: '1400000000000000091',
      state: 'closing',
    });
    expect(moved?.evidence.copy).toEqual({
      channelId: '500000000000000011',
      messageId: '1400000000000000091',
    });
  });

  test('card edits that keep failing stop holding up the resolution patrol', async () => {
    const store = new MemoryReportStore();
    const open = await filed(store, report());
    await store.rememberCard(GUILD, open.id, {
      channelId: '500000000000000009',
      messageId: '1400000000000000070',
    });
    await store.beginDecision({
      guildId: GUILD,
      id: open.id,
      token: 't',
      kind: 'dismiss',
      now: NOW,
      staleMs: MINUTE,
    });
    await store.resolve({
      guildId: GUILD,
      id: open.id,
      status: 'dismissed',
      by: MODERATOR,
      at: NOW,
      note: null,
      reporterNote: null,
      actionKind: null,
      caseIds: [],
      token: 't',
      evidenceExpiresAt: NOW + 30 * DAY,
      close: { action: null, dueAt: null },
    });
    await store.recordNotification(GUILD, open.id, 'dismissed', 'sent', NOW);

    for (let n = 0; n < 4; n += 1) await store.noteCardEditFailure(GUILD, open.id);
    expect(await store.unfinishedResolutions(GUILD, 10)).toHaveLength(1);

    await store.noteCardEditFailure(GUILD, open.id);
    expect(await store.unfinishedResolutions(GUILD, 10)).toEqual([]);
  });

  test('a note written after the evidence was purged is purged too', async () => {
    const store = new MemoryReportStore();
    const open = await filed(store, report());
    expect(await store.purgeExpiredEvidence(NOW + 90 * DAY, 10)).toBe(1);

    await store.beginDecision({
      guildId: GUILD,
      id: open.id,
      token: 't',
      kind: 'dismiss',
      now: NOW + 95 * DAY,
      staleMs: MINUTE,
    });
    const resolved = await store.resolve({
      guildId: GUILD,
      id: open.id,
      status: 'dismissed',
      by: MODERATOR,
      at: NOW + 95 * DAY,
      note: 'internal',
      reporterNote: 'Thanks, it was a joke between friends.',
      actionKind: null,
      caseIds: [],
      token: 't',
      evidenceExpiresAt: NOW + 125 * DAY,
      close: { action: null, dueAt: null },
    });
    expect(resolved?.reporterNote).toBe('Thanks, it was a joke between friends.');

    expect(await store.purgeExpiredEvidence(NOW + 95 * DAY + MINUTE, 10)).toBe(1);
    expect(await store.get(GUILD, open.id)).toMatchObject({
      reporterNote: null,
      resolutionNote: 'internal',
      evidence: { purged: true },
    });
  });

  test('unfinished resolutions: a stale card or a missing notification', async () => {
    const store = new MemoryReportStore();
    const open = await filed(store, report());
    await store.rememberCard(GUILD, open.id, {
      channelId: '500000000000000009',
      messageId: '1400000000000000070',
    });
    await store.beginDecision({
      guildId: GUILD,
      id: open.id,
      token: 't',
      kind: 'dismiss',
      now: NOW,
      staleMs: MINUTE,
    });
    const resolved = await store.resolve({
      guildId: GUILD,
      id: open.id,
      status: 'dismissed',
      by: MODERATOR,
      at: NOW,
      note: null,
      reporterNote: null,
      actionKind: null,
      caseIds: [],
      token: 't',
      evidenceExpiresAt: NOW + 30 * DAY,
      close: { action: null, dueAt: null },
    });

    expect(await store.unfinishedResolutions(GUILD, 10)).toHaveLength(1);

    await store.markCardVersion(GUILD, open.id, resolved?.version ?? 0);
    expect(await store.unfinishedResolutions(GUILD, 10)).toHaveLength(1);

    await store.recordNotification(GUILD, open.id, 'dismissed', 'skipped', NOW);
    expect(await store.unfinishedResolutions(GUILD, 10)).toEqual([]);
  });

  test('the purge empties evidence and reporter text but keeps the record', async () => {
    const store = new MemoryReportStore();
    const open = await filed(
      store,
      report({
        source: {
          channelId: '500000000000000001',
          messageId: '1400000000000000001',
          authorId: MEMBER,
        },
        evidence: {
          message: {
            status: 'captured',
            snapshot: {
              id: '1400000000000000001',
              channelId: '500000000000000001',
              authorId: MEMBER,
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
        },
      }),
    );

    expect(await store.purgeExpiredEvidence(NOW + 89 * DAY, 10)).toBe(0);
    expect(await store.purgeExpiredEvidence(NOW + 90 * DAY, 10)).toBe(1);

    const purged = await store.get(GUILD, open.id);
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
    expect((await store.listEvents(GUILD, open.id)).map((event) => event.kind)).toEqual([
      'submitted',
      'evidence_purged',
    ]);
    expect(await store.purgeExpiredEvidence(NOW + 200 * DAY, 10)).toBe(0);
  });
});

describe('drafts', () => {
  const schema = z.object({ value: z.string() });

  test('ids are ten characters from the case alphabet', () => {
    for (let i = 0; i < 50; i += 1) expect(newDraftId()).toMatch(DRAFT_ID_PATTERN);
  });

  test('the memory twin expires, takes once and keeps an outcome apart', async () => {
    const time = clock();
    const drafts = new MemoryDraftStore(time.now);

    await drafts.put(GUILD, 'abc', { value: 'x' }, MINUTE);
    expect(await drafts.get(GUILD, 'abc', schema)).toEqual({ value: 'x' });
    expect(await drafts.get(OTHER_GUILD, 'abc', schema)).toBeNull();
    expect(await drafts.get(GUILD, 'abc', z.object({ other: z.number() }))).toBeNull();

    await drafts.putOutcome(GUILD, 'abc', { value: 'done' });
    expect(await drafts.take(GUILD, 'abc', schema)).toEqual({ value: 'x' });
    expect(await drafts.take(GUILD, 'abc', schema)).toBeNull();
    expect(await drafts.getOutcome(GUILD, 'abc', schema)).toEqual({ value: 'done' });

    await drafts.put(GUILD, 'def', { value: 'y' }, MINUTE);
    time.advance(MINUTE);
    expect(await drafts.get(GUILD, 'def', schema)).toBeNull();
  });
});

class FakeRedis {
  readonly strings = new Map<string, string>();
  readonly sets = new Map<string, Map<string, number>>();
  readonly ttls = new Map<string, number>();

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    if (args.includes('NX') && this.strings.has(key)) return null;
    this.strings.set(key, value);
    const px = args.indexOf('PX');
    if (px >= 0) this.ttls.set(key, Number(args[px + 1]));
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.strings.get(key) ?? null;
    this.strings.delete(key);
    return value;
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.sets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.sets.set(key, set);
    return 1;
  }

  async zrem(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async zrangebyscore(
    key: string,
    _min: string,
    max: number,
    _withScores: string,
    _limit: string,
    offset: number,
    count: number,
  ): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Map<string, number>()).entries()]
      .filter(([, score]) => score <= max)
      .sort((a, b) => a[1] - b[1])
      .slice(offset, offset + count)
      .flatMap(([member, score]) => [member, String(score)]);
  }
}

describe('Redis stores', () => {
  test('drafts live under the documented key with a TTL and parse through zod', async () => {
    const redis = new FakeRedis();
    const drafts = new RedisDraftStore(redis as unknown as Redis);

    await drafts.put(GUILD, 'Abc1234567', { value: 'x' }, 15 * MINUTE);
    expect(redis.strings.has(`proton:moderation:draft:${GUILD}:Abc1234567`)).toBe(true);
    expect(redis.ttls.get(`proton:moderation:draft:${GUILD}:Abc1234567`)).toBe(15 * MINUTE);

    await drafts.putOutcome(GUILD, 'Abc1234567', { value: 'done' });
    expect(redis.strings.has(`proton:moderation:draft:${GUILD}:Abc1234567:done`)).toBe(true);

    expect(await drafts.take(GUILD, 'Abc1234567', z.object({ value: z.string() }))).toEqual({
      value: 'x',
    });
    expect(await drafts.get(GUILD, 'Abc1234567', z.object({ value: z.string() }))).toBeNull();

    redis.strings.set(`proton:moderation:draft:${GUILD}:bad`, '{not json');
    expect(await drafts.get(GUILD, 'bad', z.object({ value: z.string() }))).toBeNull();
  });

  test('the reaction gate: first claims, the same event re-enters, another is dropped', async () => {
    const redis = new FakeRedis();
    const gate = new RedisReactionGate(redis as unknown as Redis);
    const key = `proton:moderation:reaction:${GUILD}:5:6:7`;

    expect(await gate.claim(GUILD, '5', '6', '7', 'event-1')).toBe('claimed');
    expect(redis.strings.get(key)).toBe('event-1');
    expect(redis.ttls.get(key)).toBe(10 * MINUTE);
    expect(await gate.claim(GUILD, '5', '6', '7', 'event-1')).toBe('redelivery');
    expect(await gate.claim(GUILD, '5', '6', '7', 'event-2')).toBe('duplicate');

    await gate.release(GUILD, '5', '6', '7');
    expect(await gate.claim(GUILD, '5', '6', '7', 'event-2')).toBe('claimed');
  });

  test('prompts are kept in a sorted set by due time', async () => {
    const redis = new FakeRedis();
    const prompts = new RedisPromptStore(redis as unknown as Redis);

    await prompts.record(GUILD, '500000000000000001', '1400000000000000001', NOW + MINUTE);
    await prompts.record(GUILD, '500000000000000001', '1400000000000000002', NOW + 5 * MINUTE);

    expect(await prompts.overdue(GUILD, NOW + 2 * MINUTE, 10)).toEqual([
      { channelId: '500000000000000001', messageId: '1400000000000000001', dueAt: NOW + MINUTE },
    ]);

    await prompts.remove(GUILD, '500000000000000001', '1400000000000000001');
    expect(await prompts.overdue(GUILD, NOW + 2 * MINUTE, 10)).toEqual([]);
    expect(redis.sets.has(`proton:moderation:prompts:${GUILD}`)).toBe(true);
  });
});
