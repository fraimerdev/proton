import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import type { moderationConfigSchema } from '../src/config.ts';
import { PURGE_EVIDENCE_JOB_ID, purgeModerationEvidence } from '../src/purge.ts';
import { RUN_LEASE_MS } from '../src/reports/automation.ts';
import { DEFAULT_STAFF_ALERT } from '../src/reports/config.ts';
import {
  armPatrol,
  createPatrolArmingListener,
  createPatrolHandler,
  PATROL_INTERVAL_MS,
  PATROL_JOB,
  PATROL_KEY,
  PATROL_TARGETS_MAX,
  runAutomationPatrol,
  shortestUnreviewedMs,
} from '../src/reports/patrol.ts';
import { EMPTY_EVIDENCE, type ReportRecord } from '../src/reports/types.ts';
import { configChangedEvent, guildAvailableEvent, moderationEvent } from './drivers.ts';
import { CHANNEL, GUILD, MEMBER, MODERATOR, REPORTER } from './harness.ts';
import { MemoryCaseMessageStore } from './punish-stores.ts';
import { MemoryReportStore } from './reports-memory-store.ts';
import { NOW, REPORT_CHANNEL, reportsRig } from './reports-setup.ts';

type ConfigInput = z.input<typeof moderationConfigSchema>;

const WAITING_RULE = {
  id: 'waiting',
  name: 'Waiting too long',
  conditions: { unreviewedFor: '1h' },
  actions: [{ kind: 'alert' as const, roleIds: [], message: DEFAULT_STAFF_ALERT }],
};

function setup(options: { enabled?: boolean; moderation?: boolean } = {}) {
  const rig = reportsRig({ reports: { automation: [WAITING_RULE] } });
  const configInput: ConfigInput = {
    ...(options.moderation === false ? { enabled: false } : {}),
    reports: {
      enabled: options.enabled ?? true,
      channelId: REPORT_CHANNEL,
      automation: [WAITING_RULE],
    },
  };
  const overrides = () => rig.overrides({ configInput });
  const ctx = () => rig.h.context(overrides());

  const file = async (): Promise<ReportRecord> => {
    const result = await rig.store.submit(
      {
        guildId: GUILD,
        reporterId: REPORTER,
        targetId: MEMBER,
        method: 'command',
        reasonId: 'spam',
        reason: 'Spam or flooding',
        customReason: null,
        comment: null,
        source: null,
        evidence: EMPTY_EVIDENCE,
        idempotencyKey: `test:${rig.store.rows.size + 1}`,
        now: rig.h.now(),
      },
      {
        cooldownMs: 0,
        bypassCooldown: true,
        duplicateProtection: false,
        maxOpenPerMember: 100,
        maxOpenPerServer: 1000,
      },
    );
    if (result.status === 'refused') throw new Error(`the report was refused: ${result.code}`);
    return result.report;
  };

  return {
    rig,
    ctx,
    overrides,
    file,
    patrol: () => runAutomationPatrol(ctx(), rig.deps, rig.h.now()),
    listen: (event: Parameters<typeof rig.h.listen>[0]) =>
      rig.h.listen(event, [createPatrolArmingListener(rig.deps)], overrides()),
  };
}

describe('arming the patrol', () => {
  test('it books the patrol five minutes out and keeps an existing booking', async () => {
    const t = setup();

    await armPatrol(t.ctx(), NOW);
    await armPatrol(t.ctx(), NOW + 60_000);

    expect(t.rig.h.pendingJobs()).toEqual([
      expect.objectContaining({
        jobId: PATROL_JOB,
        naturalKey: PATROL_KEY,
        runAt: new Date(NOW + PATROL_INTERVAL_MS),
      }),
    ]);
    expect(t.rig.h.scheduledJobs.map((call) => call.options?.replace ?? false)).toEqual([
      false,
      false,
    ]);
  });

  test('switched-off user reports keep it, so existing reports are still repaired', async () => {
    const t = setup({ enabled: false });

    await armPatrol(t.ctx(), NOW);

    expect(t.rig.h.pendingJobs().map((job) => job.jobId)).toEqual([PATROL_JOB]);
    expect(t.rig.h.cancelled).toEqual([]);
  });

  test('a server that never set up user reports gets no patrol', async () => {
    const t = setup();
    const ctx = t.rig.h.context(t.rig.overrides({ configInput: { reports: { enabled: false } } }));

    await armPatrol(ctx, NOW);

    expect(t.rig.h.scheduledJobs).toEqual([]);
    expect(t.rig.h.cancelled).toEqual([{ jobId: PATROL_JOB, naturalKey: PATROL_KEY }]);
  });

  test('guild.available, a moderation config change and a submission arm it', async () => {
    const t = setup();
    const submitted = moderationEvent('moderation.report_submitted', {
      guildId: GUILD,
      reportId: 'Rk3P9aQ',
      number: 1,
      reporterId: REPORTER,
      targetId: MEMBER,
      method: 'command',
      reason: null,
      channelId: null,
      messageId: null,
      createdAt: NOW,
    });

    await t.listen(guildAvailableEvent());
    await t.listen(configChangedEvent());
    await t.listen(submitted);

    expect(t.rig.h.scheduledJobs.map((call) => call.jobId)).toEqual([
      PATROL_JOB,
      PATROL_JOB,
      PATROL_JOB,
    ]);
    expect(t.rig.h.pendingJobs()).toHaveLength(1);
  });

  test("another module's config change leaves it alone", async () => {
    const t = setup();

    await t.listen(configChangedEvent({ moduleId: 'tickets' }));

    expect(t.rig.h.scheduledJobs).toEqual([]);
    expect(t.rig.h.cancelled).toEqual([]);
  });

  test('switching Moderation off cancels it on the config change', async () => {
    const t = setup({ moderation: false });

    await t.listen(guildAvailableEvent());
    expect(t.rig.h.cancelled).toEqual([]);

    await t.listen(configChangedEvent({ enabledAfter: false }));
    expect(t.rig.h.scheduledJobs).toEqual([]);
    expect(t.rig.h.cancelled).toEqual([{ jobId: PATROL_JOB, naturalKey: PATROL_KEY }]);
  });
});

describe('the automation patrol', () => {
  test('a report left unclaimed long enough sets off a time rule', async () => {
    const t = setup();
    await t.file();

    expect((await t.patrol()).fired).toBe(0);

    t.rig.h.advance(61 * 60_000);
    const result = await t.patrol();

    expect(result).toMatchObject({ evaluated: 1, fired: 1 });
    expect(t.rig.h.sentIn(REPORT_CHANNEL)).toHaveLength(1);

    t.rig.h.advance(PATROL_INTERVAL_MS);
    expect((await t.patrol()).fired).toBe(0);
    expect(t.rig.h.sentIn(REPORT_CHANNEL)).toHaveLength(1);
  });

  test('a claimed report does not', async () => {
    const t = setup();
    const report = await t.file();
    await t.rig.store.claim(GUILD, report.id, MODERATOR, t.rig.h.now());

    t.rig.h.advance(61 * 60_000);

    expect((await t.patrol()).evaluated).toBe(0);
    expect(t.rig.h.sentIn(REPORT_CHANNEL)).toEqual([]);
  });

  test('it resumes a run whose lease ran out', async () => {
    const t = setup();
    const report = await t.file();
    t.rig.h.advance(30 * 60_000);
    await t.rig.store.claimRun({
      id: 'run-stale',
      guildId: GUILD,
      ruleId: 'waiting',
      ruleName: 'Waiting too long',
      targetId: MEMBER,
      episodeStart: 0,
      reportIds: [report.id],
      now: t.rig.h.now(),
      leaseMs: RUN_LEASE_MS,
    });

    t.rig.h.advance(31 * 60_000);
    const result = await t.patrol();

    expect(result).toMatchObject({ resumed: 1, fired: 0 });
    expect(t.rig.store.runs.get('run-stale')?.status).toBe('done');
    expect(t.rig.h.sentIn(REPORT_CHANNEL)).toHaveLength(1);
  });

  test('it deletes overdue Finish report prompts and carries on past a failure', async () => {
    const t = setup();
    await t.rig.prompts.record(GUILD, CHANNEL, '1400000000000000101', NOW - 1000);
    await t.rig.prompts.record(GUILD, CHANNEL, '1400000000000000102', NOW - 500);
    await t.rig.prompts.record(GUILD, CHANNEL, '1400000000000000103', NOW + 60_000);
    t.rig.h.rest.respond(
      `DELETE /channels/${CHANNEL}/messages/1400000000000000101`,
      { status: 500, body: { message: 'Internal Server Error' } },
      { times: 1 },
    );

    const result = await t.patrol();

    expect(result.prompts).toBe(1);
    expect(t.rig.h.deletes().map((ref) => ref.messageId)).toEqual([
      '1400000000000000101',
      '1400000000000000102',
    ]);
    expect([...(t.rig.prompts.prompts.get(GUILD)?.keys() ?? [])]).toEqual([
      `${CHANNEL}:1400000000000000101`,
      `${CHANNEL}:1400000000000000103`,
    ]);
  });

  test('switched-off Moderation patrols nothing', async () => {
    const t = setup({ moderation: false });
    await t.file();
    await t.rig.prompts.record(GUILD, CHANNEL, '1400000000000000101', NOW - 1000);
    t.rig.h.advance(61 * 60_000);

    expect(await t.patrol()).toEqual({
      resumed: 0,
      failed: 0,
      cancelled: 0,
      evaluated: 0,
      fired: 0,
      prompts: 0,
      cursor: null,
    });
    expect(t.rig.h.rest.calls).toEqual([]);
  });

  test('more waiting members than one patrol checks are reached on the next patrol', async () => {
    const t = setup();
    const targets = Array.from(
      { length: PATROL_TARGETS_MAX + 1 },
      (_, n) => `4100000000000${String(n).padStart(5, '0')}`,
    );
    for (const targetId of targets) {
      const result = await t.rig.store.submit(
        {
          guildId: GUILD,
          reporterId: REPORTER,
          targetId,
          method: 'command',
          reasonId: null,
          reason: null,
          customReason: null,
          comment: null,
          source: null,
          evidence: EMPTY_EVIDENCE,
          idempotencyKey: `many:${targetId}`,
          now: t.rig.h.now(),
        },
        {
          cooldownMs: 0,
          bypassCooldown: true,
          duplicateProtection: false,
          maxOpenPerMember: 100,
          maxOpenPerServer: 1000,
        },
      );
      if (result.status === 'refused') throw new Error(result.code);
    }
    t.rig.h.advance(61 * 60_000);

    const first = await runAutomationPatrol(t.ctx(), t.rig.deps, t.rig.h.now());
    expect(first).toMatchObject({ evaluated: PATROL_TARGETS_MAX, fired: PATROL_TARGETS_MAX });
    expect(first.cursor).toBe(targets[PATROL_TARGETS_MAX - 1] ?? null);

    const second = await runAutomationPatrol(t.ctx(), t.rig.deps, t.rig.h.now(), first.cursor);
    expect(second).toMatchObject({ evaluated: 1, fired: 1, cursor: null });

    const alerted = new Set([...t.rig.store.runs.values()].map((run) => run.targetId));
    expect(alerted.size).toBe(targets.length);
  });

  test('the patrol job carries the cursor to its next round', async () => {
    const t = setup();
    for (let n = 0; n <= PATROL_TARGETS_MAX; n += 1) {
      await t.rig.store.submit(
        {
          guildId: GUILD,
          reporterId: REPORTER,
          targetId: `4200000000000${String(n).padStart(5, '0')}`,
          method: 'command',
          reasonId: null,
          reason: null,
          customReason: null,
          comment: null,
          source: null,
          evidence: EMPTY_EVIDENCE,
          idempotencyKey: `job:${n}`,
          now: t.rig.h.now(),
        },
        {
          cooldownMs: 0,
          bypassCooldown: true,
          duplicateProtection: false,
          maxOpenPerMember: 100,
          maxOpenPerServer: 1000,
        },
      );
    }
    t.rig.h.advance(61 * 60_000);
    const handlers = { [PATROL_JOB]: createPatrolHandler(t.rig.deps) };

    await t.rig.h.job(PATROL_JOB, {}, { ...t.overrides(), handlers, naturalKey: PATROL_KEY });
    const booked = t.rig.h.pendingJobs().find((job) => job.jobId === PATROL_JOB);
    expect(booked?.data).toEqual({ cursor: `4200000000000${String(49).padStart(5, '0')}` });

    await t.rig.h.job(PATROL_JOB, booked?.data, {
      ...t.overrides(),
      handlers,
      naturalKey: PATROL_KEY,
    });
    expect(t.rig.h.pendingJobs().find((job) => job.jobId === PATROL_JOB)?.data).toEqual({
      cursor: null,
    });
    expect(t.rig.store.runs.size).toBe(PATROL_TARGETS_MAX + 1);
  });

  test('the shortest wait decides which reports are old enough to look at', () => {
    const t = setup();
    const config = t.ctx().config;

    expect(shortestUnreviewedMs(config)).toBe(60 * 60_000);
    expect(
      shortestUnreviewedMs({ ...config, reports: { ...config.reports, automation: [] } }),
    ).toBeNull();
  });
});

describe('the evidence purge', () => {
  test('it works through expired reports in batches and purges case messages once', async () => {
    const reports = new MemoryReportStore(() => NOW);
    const calls: number[] = [];
    const counted = {
      purgeExpiredEvidence: async (now: number, limit: number) => {
        const purged = await reports.purgeExpiredEvidence(now, limit);
        calls.push(purged);
        return purged;
      },
    };

    for (let n = 1; n <= 5; n += 1) {
      await reports.submit(
        {
          guildId: GUILD,
          reporterId: `40000000000000002${n}`,
          targetId: MEMBER,
          method: 'command',
          reasonId: null,
          reason: null,
          customReason: 'typed by the reporter',
          comment: 'details',
          source: null,
          evidence: EMPTY_EVIDENCE,
          idempotencyKey: `purge:${n}`,
          now: NOW - 100 * 24 * 60 * 60_000,
        },
        {
          cooldownMs: 0,
          bypassCooldown: true,
          duplicateProtection: false,
          maxOpenPerMember: 100,
          maxOpenPerServer: 1000,
        },
      );
    }

    const caseMessages = new MemoryCaseMessageStore(() => NOW);
    await caseMessages.save([
      {
        caseId: 'Kcase01',
        guildId: GUILD,
        messageId: '1400000000000000201',
        channelId: CHANNEL,
        authorId: MEMBER,
        content: 'old',
        attachments: [],
        createdAt: NOW - 40 * 24 * 60 * 60_000,
        deletedAt: null,
        proof: false,
        expiresAt: NOW - 1000,
      },
    ]);

    const purged = await purgeModerationEvidence(
      { reports: counted, caseMessages },
      new Date(NOW),
      { batch: 2 },
    );

    expect(purged).toEqual({ reports: 5, caseMessages: 1 });
    expect(calls).toEqual([2, 2, 1]);
    expect([...reports.rows.values()].every((row) => row.comment === null)).toBe(true);
    expect(PURGE_EVIDENCE_JOB_ID).toBe('purge-evidence');
  });

  test('it stops after the round limit and tolerates unbound stores', async () => {
    let asked = 0;
    const endless = {
      purgeExpiredEvidence: async (_now: number, limit: number) => {
        asked += 1;
        return limit;
      },
    };

    expect(
      await purgeModerationEvidence({ reports: endless }, new Date(NOW), { batch: 3, rounds: 4 }),
    ).toEqual({ reports: 12, caseMessages: 0 });
    expect(asked).toBe(4);
    expect(await purgeModerationEvidence({}, new Date(NOW))).toEqual({
      reports: 0,
      caseMessages: 0,
    });
  });
});
