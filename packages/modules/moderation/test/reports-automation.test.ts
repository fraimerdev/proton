import { describe, expect, test } from 'bun:test';
import type { PlaceholderEnvironment } from '@proton/core/placeholders';
import type { z } from 'zod';
import type { moderationConfigSchema } from '../src/config.ts';
import {
  AUTOMATION_ACTOR,
  automationKey,
  conditionsMet,
  createAutomationListener,
  evaluateTarget,
  RUN_LEASE_MS,
  resumeStaleRuns,
  STOP_MESSAGES,
} from '../src/reports/automation.ts';
import {
  type automationRuleSchema,
  DEFAULT_STAFF_ALERT,
  refineReportsWrite,
  reportsConfigSchema,
} from '../src/reports/config.ts';
import { EMPTY_EVIDENCE, type ReportRecord } from '../src/reports/types.ts';
import { moderationEvent } from './drivers.ts';
import { GRANT_ROLE, GUILD, HIGH_ROLE, MEMBER, MOD_ROLE, REPORTER } from './harness.ts';
import { MemoryCaseLedger } from './punish-stores.ts';
import { REPORT_CHANNEL, reportsRig } from './reports-setup.ts';

type RuleInput = z.input<typeof automationRuleSchema>;
type ConfigInput = z.input<typeof moderationConfigSchema>;

const REPORTERS = [REPORTER, '400000000000000011', '400000000000000012', '400000000000000013'];
const MORE_REPORTERS = ['400000000000000014', '400000000000000015', '400000000000000016'];

const OPEN_LIMITS = {
  cooldownMs: 0,
  bypassCooldown: true,
  duplicateProtection: false,
  maxOpenPerMember: 100,
  maxOpenPerServer: 1000,
};

const ALERT = { kind: 'alert' as const, roleIds: [], message: DEFAULT_STAFF_ALERT };

function placeholders(): PlaceholderEnvironment {
  return {
    applicationId: '1200000000000000001',
    bot: async () => ({ id: '300000000000000001', name: 'Proton', supportUrl: 'https://prtn.xyz' }),
    server: async (guildId) => ({ id: guildId, name: 'Proton test server' }),
    user: async (userId) => ({
      id: userId,
      username: 'mallory',
      globalName: 'Mallory',
      avatarHash: null,
    }),
    now: () => Date.now(),
  };
}

interface SetupOptions {
  enabled?: boolean;
  punish?: ConfigInput['punish'];
}

function setup(automation: RuleInput[], options: SetupOptions = {}) {
  const rig = reportsRig({ reports: { automation } });
  const ledger = new MemoryCaseLedger(rig.h.now);
  ledger.follow(rig.h.recorder);
  rig.deps.ledger = ledger;
  rig.deps.placeholders = placeholders();

  const configInput: ConfigInput = {
    reports: {
      enabled: options.enabled ?? true,
      channelId: REPORT_CHANNEL,
      automation,
    },
    ...(options.punish ? { punish: options.punish } : {}),
  };

  const ctx = () => rig.h.context(rig.overrides({ configInput }));
  let filed = 0;

  const file = async (
    reporterId: string,
    extra: Partial<Pick<ReportRecord, 'comment' | 'customReason'>> = {},
  ): Promise<ReportRecord> => {
    filed += 1;
    rig.h.advance(1000);

    const result = await rig.store.submit(
      {
        guildId: GUILD,
        reporterId,
        targetId: MEMBER,
        method: 'command',
        reasonId: 'spam',
        reason: 'Spam or flooding',
        customReason: extra.customReason ?? null,
        comment: extra.comment ?? null,
        source: null,
        evidence: EMPTY_EVIDENCE,
        idempotencyKey: `test:${filed}`,
        now: rig.h.now(),
      },
      OPEN_LIMITS,
    );
    if (result.status === 'refused') throw new Error(`the report was refused: ${result.code}`);
    return result.report;
  };

  return {
    rig,
    ledger,
    ctx,
    file,
    evaluate: () => evaluateTarget(ctx(), rig.deps, MEMBER, rig.h.now()),
    resume: () => resumeStaleRuns(ctx(), rig.deps, rig.h.now()),
    runs: () => [...rig.store.runs.values()],
    alerts: () => rig.h.sentIn(REPORT_CHANNEL),
    bans: () =>
      rig.h.rest.calls.filter((call) => call.method === 'PUT' && call.path.includes('/bans/')),
  };
}

function rule(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    id: 'several',
    name: 'Several members report the same person',
    conditions: { reporters: 3 },
    actions: [ALERT],
    ...overrides,
  };
}

describe('when a rule fires', () => {
  test('it fires once per episode and again only for new reports', async () => {
    const t = setup([rule()]);

    for (const reporter of REPORTERS.slice(0, 2)) {
      await t.file(reporter);
      expect(await t.evaluate()).toEqual([]);
    }

    await t.file(REPORTERS[2] ?? '');
    const fired = await t.evaluate();

    expect(fired.map((firing) => firing.status)).toEqual(['done']);
    expect(t.alerts()).toHaveLength(1);

    expect(await t.evaluate()).toEqual([]);
    await t.file(REPORTERS[3] ?? '');
    expect(await t.evaluate()).toEqual([]);

    for (const reporter of MORE_REPORTERS.slice(0, 2)) await t.file(reporter);
    expect((await t.evaluate()).map((firing) => firing.status)).toEqual(['done']);
    expect(t.alerts()).toHaveLength(2);
    expect(t.runs()).toHaveLength(2);
  });

  test('a one-report rule fires exactly once across three evaluations', async () => {
    const t = setup([rule({ conditions: { reports: 1 } })]);
    await t.file(REPORTER);

    const firings = [...(await t.evaluate()), ...(await t.evaluate()), ...(await t.evaluate())];

    expect(firings).toHaveLength(1);
    expect(t.alerts()).toHaveLength(1);
  });

  test('distinct reporters count members, not submissions', async () => {
    const t = setup([rule()]);
    for (let n = 0; n < 3; n += 1) await t.file(REPORTER);

    expect(await t.evaluate()).toEqual([]);
    expect(t.alerts()).toEqual([]);
  });

  test('match all needs every condition and match any needs one', async () => {
    const both = { reports: 3, reporters: 2 };
    const all = setup([rule({ match: 'all', conditions: both })]);
    const any = setup([rule({ match: 'any', conditions: both })]);

    for (const t of [all, any]) {
      for (let n = 0; n < 3; n += 1) await t.file(REPORTER);
    }

    expect(await all.evaluate()).toEqual([]);
    expect((await any.evaluate()).map((firing) => firing.status)).toEqual(['done']);
  });

  test('a disabled rule, and a rule with nothing to do, never run', async () => {
    const t = setup([
      rule({ id: 'off', enabled: false, conditions: { reports: 1 } }),
      rule({ id: 'empty', conditions: { reports: 1 }, actions: [] }),
    ]);
    await t.file(REPORTER);

    expect(await t.evaluate()).toEqual([]);
  });

  test('switched-off user reports start nothing', async () => {
    const t = setup([rule({ conditions: { reports: 1 } })], { enabled: false });
    await t.file(REPORTER);

    expect(await t.evaluate()).toEqual([]);
    expect(t.runs()).toEqual([]);
  });

  test('every report it covered records the firing, with ids only', async () => {
    const t = setup([rule({ conditions: { reports: 1 } })]);
    const report = await t.file(REPORTER);
    const [firing] = await t.evaluate();

    const events = await t.rig.store.listEvents(GUILD, report.id);
    const fired = events.find((event) => event.kind === 'automation_fired');

    expect(fired?.data).toEqual({ ruleId: 'several', runId: firing?.runId });
    expect(fired?.source).toBe('automation');
  });
});

describe('the alert', () => {
  test('the default alert names the member and the counts', async () => {
    const t = setup([rule()]);
    for (const reporter of REPORTERS.slice(0, 3)) await t.file(reporter);
    await t.evaluate();

    const [alert] = t.alerts();
    const embed = alert?.embeds?.[0];

    expect(embed?.title).toBe('Several members reported mallory');
    expect(embed?.description).toContain(
      `3 different members have filed 3 reports about <@${MEMBER}>`,
    );
    expect(embed?.footer?.text).toBe('Rule: Several members report the same person');
    expect(alert?.allowed_mentions).toEqual({ parse: [] });
  });

  test('it pings only the roles the action names', async () => {
    const message = {
      content: `@everyone <@&${HIGH_ROLE}> look at {target.mention}`,
      mentions: { everyone: true, roles: true, users: true },
    };
    const t = setup([
      rule({
        conditions: { reports: 1 },
        actions: [{ kind: 'alert', roleIds: [MOD_ROLE], message }],
      }),
    ]);
    await t.file(REPORTER);
    await t.evaluate();

    const [alert] = t.alerts();
    expect(alert?.content?.startsWith(`<@&${MOD_ROLE}>\n`)).toBe(true);
    expect(alert?.allowed_mentions).toEqual({ parse: [], roles: [MOD_ROLE] });
  });

  test('role pings switched off in the message ping nobody', async () => {
    const message = { content: 'Look at {target.mention}', mentions: { roles: false } };
    const t = setup([
      rule({
        conditions: { reports: 1 },
        actions: [{ kind: 'alert', roleIds: [MOD_ROLE], message }],
      }),
    ]);
    await t.file(REPORTER);
    await t.evaluate();

    const [alert] = t.alerts();
    expect(alert?.content).toBe(`Look at <@${MEMBER}>`);
    expect(alert?.allowed_mentions).toEqual({ parse: [] });
  });

  test('a chosen alert channel wins over the report channel, and the send is not recorded', async () => {
    const t = setup([
      rule({
        conditions: { reports: 1 },
        actions: [{ ...ALERT, channelId: '500000000000000001' }],
      }),
    ]);
    await t.file(REPORTER);
    const [firing] = await t.evaluate();

    expect(t.rig.h.sentIn('500000000000000001')).toHaveLength(1);
    expect(t.alerts()).toEqual([]);

    const send = t.rig.h.requests.find((request) => request.kind === 'send');
    expect(send?.record).toBe(false);
    expect(send?.idempotencyKey).toBe(automationKey(firing?.runId ?? '', 0));
  });
});

describe('the member notice', () => {
  test('it reaches the reported member and never says who reported or what', async () => {
    const message = {
      embeds: [
        {
          title: 'A note from {server.name}',
          description: 'Rule: {rule.name}. {report.reporter_count}{report.id}{target.username}',
        },
      ],
    };
    const t = setup([rule({ conditions: { reports: 1 }, actions: [{ kind: 'dm', message }] })]);
    const report = await t.file(REPORTER);
    const [firing] = await t.evaluate();

    const [dm] = t.rig.h.dms();
    expect(dm?.userId).toBe(MEMBER);
    expect(dm?.message.embeds?.[0]?.title).toBe('A note from Proton test server');
    expect(dm?.message.embeds?.[0]?.description).toBe(
      'Rule: Several members report the same person.',
    );
    expect(JSON.stringify(dm?.message)).not.toContain(report.id);
    expect(firing?.status).toBe('done');
  });
});

describe('punishing from a rule', () => {
  const PUNISH = {
    kind: 'punish' as const,
    punishment: 'ban' as const,
    reason: 'Reported by several members',
  };

  test('it bans through the punish pipeline as Proton and links the case', async () => {
    const t = setup([
      rule({ conditions: { reports: 1 }, actions: [PUNISH], acknowledgedRisk: true }),
    ]);
    await t.file(REPORTER);
    const [firing] = await t.evaluate();

    expect(firing?.status).toBe('done');
    expect(t.bans()).toHaveLength(1);

    const [ban] = t.ledger.cases.filter((entry) => entry.kind === 'ban');
    expect(ban?.actorId).toBe(AUTOMATION_ACTOR.id);
    expect(ban?.idempotencyKey).toBe(`${automationKey(firing?.runId ?? '', 0)}:action`);

    const run = t.runs()[0];
    expect(run?.outcomes[0]).toMatchObject({ ok: true, code: 'executed', caseId: ban?.caseId });
  });

  test('a rule saved without acknowledging the risk is refused on write', () => {
    const reports = reportsConfigSchema.parse({
      automation: [rule({ conditions: { reports: 1 }, actions: [PUNISH] })],
    });

    expect(refineReportsWrite(reports).map((issue) => issue.path)).toContain(
      'reports.automation.0.acknowledgedRisk',
    );
  });

  test('and never punishes if one reaches the worker anyway', async () => {
    const t = setup([rule({ conditions: { reports: 1 }, actions: [PUNISH] })]);
    await t.file(REPORTER);
    const [firing] = await t.evaluate();

    expect(t.bans()).toEqual([]);
    expect(firing?.status).toBe('failed');
    expect(t.runs()[0]?.outcomes[0]?.code).toBe('risk_not_acknowledged');
  });

  test('a recent case skips the punishment and leaves the run partial', async () => {
    const t = setup(
      [rule({ conditions: { reports: 1 }, actions: [PUNISH], acknowledgedRisk: true })],
      { punish: { confirmRecentCase: { enabled: true, window: '1h' } } },
    );
    t.ledger.seed({ caseId: 'Kseed01', guildId: GUILD, kind: 'ban', targetId: MEMBER });
    await t.file(REPORTER);
    const [firing] = await t.evaluate();

    expect(t.bans()).toEqual([]);
    expect(firing?.status).toBe('partial');
    expect(t.runs()[0]?.outcomes[0]).toMatchObject({ ok: false, code: 'skipped_recent_case' });
  });

  test('a report dismissed before the punishment cancels the rest of the run', async () => {
    const t = setup([
      rule({ conditions: { reports: 1 }, actions: [ALERT, PUNISH], acknowledgedRisk: true }),
    ]);
    const report = await t.file(REPORTER);

    t.rig.h.rest.respond(`POST /channels/${REPORT_CHANNEL}/messages`, () => {
      const row = t.rig.store.rows.get(report.id);
      if (row) row.status = 'dismissed';
      return { status: 200, body: { id: '1700000000000000999', channel_id: REPORT_CHANNEL } };
    });

    const [firing] = await t.evaluate();

    expect(firing?.status).toBe('cancelled');
    expect(t.alerts()).toHaveLength(1);
    expect(t.bans()).toEqual([]);
    expect(t.runs()[0]?.outcomes.map((outcome) => outcome.code)).toEqual([
      'posted',
      'conditions_no_longer_met',
    ]);
  });
});

describe('roles', () => {
  test('add and remove are recorded and keyed per step', async () => {
    const t = setup([
      rule({
        conditions: { reports: 1 },
        actions: [
          { kind: 'add_role', roleId: GRANT_ROLE },
          { kind: 'remove_role', roleId: GRANT_ROLE },
        ],
      }),
    ]);
    await t.file(REPORTER);
    const [firing] = await t.evaluate();

    const roles = t.rig.h.requests.filter((request) => request.kind.endsWith('_role'));
    expect(roles.map((request) => [request.kind, request.idempotencyKey])).toEqual([
      ['add_role', automationKey(firing?.runId ?? '', 0)],
      ['remove_role', automationKey(firing?.runId ?? '', 1)],
    ]);
    expect(roles.every((request) => request.record !== false)).toBe(true);
    expect(t.ledger.cases.filter((entry) => entry.kind.endsWith('_role'))).toHaveLength(2);
  });
});

describe('resuming an interrupted run', () => {
  async function interrupted(t: ReturnType<typeof setup>) {
    const report = await t.file(REPORTER);
    const run = await t.rig.store.claimRun({
      id: 'run-crashed',
      guildId: GUILD,
      ruleId: 'several',
      ruleName: 'Several members report the same person',
      targetId: MEMBER,
      episodeStart: 0,
      reportIds: [report.id],
      now: t.rig.h.now(),
      leaseMs: RUN_LEASE_MS,
    });
    await t.rig.store.recordRunOutcome(GUILD, 'run-crashed', {
      index: 0,
      kind: 'alert',
      ok: true,
      code: 'posted',
      message: 'Posted the alert.',
      at: t.rig.h.now(),
    });
    return run;
  }

  const ACTIONS = [ALERT, { kind: 'add_role' as const, roleId: GRANT_ROLE }];

  test('it skips the steps already recorded', async () => {
    const t = setup([rule({ conditions: { reports: 1 }, actions: ACTIONS })]);
    await interrupted(t);

    expect(await t.resume()).toEqual({ resumed: 0, failed: 0, cancelled: 0 });

    t.rig.h.advance(RUN_LEASE_MS + 1000);
    expect(await t.resume()).toEqual({ resumed: 1, failed: 0, cancelled: 0 });

    expect(t.alerts()).toEqual([]);
    expect(t.rig.h.keysUsed()).toEqual([automationKey('run-crashed', 1)]);
    expect(t.rig.store.runs.get('run-crashed')?.status).toBe('done');
    expect(await t.evaluate()).toEqual([]);
  });

  test('a held lease lets only one resumer through', async () => {
    const t = setup([rule({ conditions: { reports: 1 }, actions: ACTIONS })]);
    await interrupted(t);
    t.rig.h.advance(RUN_LEASE_MS + 1000);

    const [first, second] = await Promise.all([t.resume(), t.resume()]);

    expect((first?.resumed ?? 0) + (second?.resumed ?? 0)).toBe(1);
    expect(t.rig.h.requests.filter((request) => request.kind === 'add_role')).toHaveLength(1);
  });

  test('a run older than an hour is failed, not retried', async () => {
    const t = setup([rule({ conditions: { reports: 1 }, actions: ACTIONS })]);
    await interrupted(t);
    t.rig.h.advance(61 * 60_000);

    expect(await t.resume()).toEqual({ resumed: 0, failed: 1, cancelled: 0 });

    const run = t.rig.store.runs.get('run-crashed');
    expect(run?.status).toBe('failed');
    expect(run?.outcomes[1]).toMatchObject({
      index: 1,
      kind: 'add_role',
      code: 'interrupted',
      message: STOP_MESSAGES.interrupted,
    });
    expect(t.rig.h.requests).toEqual([]);
  });

  test('switching user reports off cancels it at its next step', async () => {
    const t = setup([rule({ conditions: { reports: 1 }, actions: ACTIONS })], {
      enabled: false,
    });
    await interrupted(t);
    t.rig.h.advance(RUN_LEASE_MS + 1000);

    expect(await t.resume()).toEqual({ resumed: 0, failed: 0, cancelled: 1 });
    expect(t.rig.store.runs.get('run-crashed')?.outcomes[1]?.code).toBe('reports_disabled');
    expect(t.rig.h.requests).toEqual([]);
  });

  test('a deleted rule cancels it', async () => {
    const t = setup([rule({ id: 'other', conditions: { reports: 1 }, actions: ACTIONS })]);
    await interrupted(t);
    t.rig.h.advance(RUN_LEASE_MS + 1000);

    expect(await t.resume()).toEqual({ resumed: 0, failed: 0, cancelled: 1 });
    expect(t.rig.store.runs.get('run-crashed')?.outcomes[1]?.code).toBe('rule_removed');
  });

  test('a report resolved while it was down cancels it on resume', async () => {
    const t = setup([rule({ conditions: { reports: 1 }, actions: ACTIONS })]);
    await interrupted(t);
    for (const row of t.rig.store.rows.values()) row.status = 'dismissed';
    t.rig.h.advance(RUN_LEASE_MS + 1000);

    expect(await t.resume()).toEqual({ resumed: 0, failed: 0, cancelled: 1 });
    expect(t.rig.store.runs.get('run-crashed')?.outcomes[1]?.code).toBe('conditions_no_longer_met');
  });
});

describe('privacy', () => {
  test('outcomes, timelines and logs never carry what the reporter wrote', async () => {
    const t = setup([
      rule({
        conditions: { reports: 1 },
        actions: [
          ALERT,
          { kind: 'dm', message: { content: 'Hello {user.mention}' } },
          { kind: 'punish', punishment: 'warn', reason: 'Automatic warning' },
        ],
        acknowledgedRisk: true,
      }),
    ]);
    const report = await t.file(REPORTER, {
      comment: 'SECRET comment text',
      customReason: 'SECRET custom reason',
    });
    await t.evaluate();

    const kept = JSON.stringify({
      runs: t.runs(),
      events: await t.rig.store.listEvents(GUILD, report.id),
      logs: t.rig.h.logs,
    });

    expect(t.runs()[0]?.outcomes).toHaveLength(3);
    expect(kept).not.toContain('SECRET');
  });
});

describe('the listener', () => {
  const payload = (guildId: string) => ({
    guildId,
    reportId: 'Rk3P9aQ',
    number: 1,
    reporterId: REPORTER,
    targetId: MEMBER,
    method: 'command' as const,
    reason: null,
    channelId: null,
    messageId: null,
    createdAt: 0,
  });

  test('a submission for this server evaluates the reported member', async () => {
    const t = setup([rule({ conditions: { reports: 1 } })]);
    await t.file(REPORTER);

    await t.rig.h.listen(
      moderationEvent('moderation.report_submitted', payload(GUILD)),
      [createAutomationListener(t.rig.deps)],
      t.rig.overrides(),
    );

    expect(t.runs()).toHaveLength(1);
  });

  test('a payload naming another server is ignored', async () => {
    const t = setup([rule({ conditions: { reports: 1 } })]);
    await t.file(REPORTER);

    await t.rig.h.listen(
      moderationEvent('moderation.report_submitted', payload('900000000000000002')),
      [createAutomationListener(t.rig.deps)],
      t.rig.overrides(),
    );

    expect(t.runs()).toEqual([]);
  });

  test('switched-off Moderation evaluates nothing', async () => {
    const t = setup([rule({ conditions: { reports: 1 } })]);
    await t.file(REPORTER);

    await t.rig.h.listen(
      moderationEvent('moderation.report_submitted', payload(GUILD)),
      [createAutomationListener(t.rig.deps)],
      t.rig.overrides({ config: { enabled: false } }),
    );

    expect(t.runs()).toEqual([]);
  });
});

describe('conditionsMet', () => {
  const row = (reporterId: string, createdAt: number, status = 'open' as const) => ({
    id: `${reporterId}:${createdAt}`,
    reporterId,
    status,
    assigneeId: null,
    createdAt,
  });
  const parsed = (input: RuleInput) =>
    reportsConfigSchema.parse({ automation: [input] }).automation[0];

  test('a rule with no condition never fires', () => {
    const noCondition = parsed(rule({ conditions: {} }));
    if (!noCondition) throw new Error('no rule');

    expect(conditionsMet(noCondition, [row(REPORTER, 0)], 0)).toBe(false);
  });

  test('unreviewedFor waits for an open, unclaimed report old enough', () => {
    const waiting = parsed(rule({ conditions: { unreviewedFor: '1h' } }));
    if (!waiting) throw new Error('no rule');

    expect(conditionsMet(waiting, [row(REPORTER, 0)], 59 * 60_000)).toBe(false);
    expect(conditionsMet(waiting, [row(REPORTER, 0)], 60 * 60_000)).toBe(true);
    expect(
      conditionsMet(waiting, [{ ...row(REPORTER, 0), assigneeId: MOD_ROLE }], 2 * 60 * 60_000),
    ).toBe(false);
  });
});
