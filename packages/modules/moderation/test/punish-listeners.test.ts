import { describe, expect, test } from 'bun:test';
import { type ProtonEvent, RULE_ENGINE_ACTOR } from '@proton/core';
import { createTimeoutJobHandler, rejoinKey } from '../src/punish/jobs.ts';
import { auditDmRoot, caseDmRoot, createPunishListeners } from '../src/punish/listeners.ts';
import { APPLY_CAP_MS, clampUntil, TIMEOUT_JOB } from '../src/punish/timeouts.ts';
import {
  actionExecutedEvent,
  auditEntryEvent,
  configChangedEvent,
  guildAvailableEvent,
  memberJoinedEvent,
  protonEvent,
  snowflake,
} from './drivers.ts';
import {
  BOT,
  baseGuildState,
  CHANNEL,
  DM_CHANNEL,
  discordError,
  GUILD,
  MEMBER,
  MODERATOR,
  REPORTER,
} from './harness.ts';
import { FULL_BOT, type KitOptions, kit } from './punish-kit.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const SEND = /^POST \/channels\/9\d+\/messages$/;

function rig(config: KitOptions['config'] = {}) {
  const state = baseGuildState(FULL_BOT);
  state.name = 'Proton HQ';
  const k = kit({ state, config });
  const overrides = { configInput: config, botPermissions: FULL_BOT, guildState: state };

  return {
    k,
    now: () => k.h.now(),
    listen: (event: ProtonEvent) => k.h.listen(event, createPunishListeners(k.deps), overrides),
    runDue: () =>
      k.h.runDue({ ...overrides, handlers: { [TIMEOUT_JOB]: createTimeoutJobHandler(k.deps) } }),
    seed: (input: {
      caseId: string;
      endsAt: number;
      appliedUntil: number | null;
      startedAt?: number;
      userId?: string;
    }) =>
      k.timeouts.record({
        caseId: input.caseId,
        guildId: GUILD,
        userId: input.userId ?? MEMBER,
        startedAt: new Date(input.startedAt ?? k.h.now()),
        endsAt: new Date(input.endsAt),
        appliedUntil: input.appliedUntil === null ? null : new Date(input.appliedUntil),
      }),
    patches: () =>
      k.h.rest.calls
        .filter((call) => call.method === 'PATCH' && call.path.startsWith(`/guilds/${GUILD}/`))
        .map((call) => ({
          path: call.path,
          until: Date.parse(
            (call.body as { communication_disabled_until: string }).communication_disabled_until,
          ),
        })),
    job: (userId: string = MEMBER) =>
      k.h.pendingJobs().find((call) => call.jobId === TIMEOUT_JOB && call.naturalKey === userId),
  };
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function timeoutAudit(
  input: { actorId: string | null; newValue: string | null; reason?: string | null },
  at: number,
) {
  return auditEntryEvent(
    {
      actionType: 24,
      actorId: input.actorId,
      targetId: MEMBER,
      reason: input.reason ?? null,
      changes: [
        {
          key: 'communication_disabled_until',
          old_value: iso(at + HOUR),
          new_value: input.newValue,
        },
      ],
    },
    { at },
  );
}

function moderationAudit(
  type: 'member.banned' | 'member.kicked' | 'member.unbanned',
  actorId: string | null,
  entryId: string = snowflake(),
): ProtonEvent {
  const actionType = { 'member.kicked': 20, 'member.banned': 22, 'member.unbanned': 23 }[type];
  return protonEvent(
    type,
    { entryId, guildId: GUILD, actionType, actorId, targetId: MEMBER, reason: 'Raiding' },
    { id: `${type}:${entryId}` },
  );
}

describe('re-arming the timeout job', () => {
  test('a server coming back books a check for every member with an open timeout', async () => {
    const r = rig();
    const now = r.now();
    await r.seed({ caseId: 'Open001', endsAt: now + 2 * HOUR, appliedUntil: now + 2 * HOUR });
    await r.seed({
      caseId: 'Past001',
      userId: REPORTER,
      startedAt: now - 2 * HOUR,
      endsAt: now - MINUTE,
      appliedUntil: now - MINUTE,
    });

    await r.listen(guildAvailableEvent());

    expect(r.job(MEMBER)?.runAt.getTime()).toBe(now + 2 * HOUR);
    expect(r.job(REPORTER)?.runAt.getTime()).toBe(now);
    expect(r.job(MEMBER)?.options).toEqual({ replace: true });

    await r.runDue();

    expect(r.k.timeouts.rows.get('Past001')?.closeReason).toBe('expired');
    expect(r.k.h.published.map((event) => [event.type, event.naturalKey])).toEqual([
      ['moderation.punishment_expired', 'Past001'],
    ]);
    expect(r.k.timeouts.rows.get('Open001')?.closedAt).toBeNull();
  });

  test('saving moderation with the module on re-arms; other modules and off do not', async () => {
    const r = rig();
    await r.seed({ caseId: 'Open002', endsAt: r.now() + HOUR, appliedUntil: r.now() + HOUR });

    await r.listen(configChangedEvent({ moduleId: 'tickets' }));
    await r.listen(configChangedEvent({ enabledAfter: false }));
    expect(r.job()).toBeUndefined();

    await r.listen(configChangedEvent());
    expect(r.job()?.runAt.getTime()).toBe(r.now() + HOUR);

    const off = rig({ enabled: false });
    await off.seed({ caseId: 'Open003', endsAt: off.now() + HOUR, appliedUntil: off.now() + HOUR });
    await off.listen(guildAvailableEvent());
    expect(off.job()).toBeUndefined();
  });
});

describe('a timed-out member who rejoins', () => {
  test('gets the rest of a long timeout reapplied once, without a new case', async () => {
    const r = rig({ punish: { extendTimeouts: true } });
    const now = r.now();
    const start = now - 30 * DAY;
    const endsAt = start + 40 * DAY;
    await r.seed({
      caseId: 'Long001',
      startedAt: start,
      endsAt,
      appliedUntil: start + APPLY_CAP_MS,
    });
    r.k.lookups.set(MEMBER, { state: 'member', roleIds: [], timeoutUntil: null, joinedAt: now });

    const until = clampUntil(endsAt, now);
    await r.listen(memberJoinedEvent(MEMBER, { joinedAt: now, at: now }));
    r.k.lookups.set(MEMBER, { state: 'member', roleIds: [], timeoutUntil: until, joinedAt: now });
    await r.listen(memberJoinedEvent(MEMBER, { joinedAt: now, at: now }));

    expect(r.patches()).toEqual([{ path: `/guilds/${GUILD}/members/${MEMBER}`, until }]);
    expect(r.k.h.requests.find((request) => request.kind === 'timeout')).toMatchObject({
      idempotencyKey: rejoinKey(GUILD, MEMBER, now),
      record: false,
    });
    expect(r.k.h.cases()).toHaveLength(0);
    expect(r.k.timeouts.rows.get('Long001')?.appliedUntil).toBe(until);
    expect(r.job()?.runAt.getTime()).toBe(endsAt);
  });

  test('only timeouts that end in the future are reapplied', async () => {
    const r = rig();
    const now = r.now();
    await r.seed({
      caseId: 'Past002',
      startedAt: now - 2 * HOUR,
      endsAt: now - MINUTE,
      appliedUntil: now - MINUTE,
    });

    await r.listen(memberJoinedEvent(MEMBER, { joinedAt: now, at: now }));

    expect(r.patches()).toEqual([]);
    expect(r.job()?.runAt.getTime()).toBe(now);
  });

  test('a timeout Discord kept through the rejoin is left alone', async () => {
    const r = rig();
    const now = r.now();
    await r.seed({ caseId: 'Kept001', endsAt: now + HOUR, appliedUntil: now + HOUR });
    r.k.lookups.set(MEMBER, {
      state: 'member',
      roleIds: [],
      timeoutUntil: now + HOUR,
      joinedAt: now,
    });

    await r.listen(memberJoinedEvent(MEMBER, { joinedAt: now, at: now }));

    expect(r.patches()).toEqual([]);
    expect(r.k.timeouts.rows.get('Kept001')?.closedAt).toBeNull();
  });

  test('a timeout someone removed by hand is not put back', async () => {
    const r = rig();
    const now = r.now();
    await r.seed({ caseId: 'Gone001', endsAt: now + HOUR, appliedUntil: now + HOUR });
    r.k.lookups.set(MEMBER, { state: 'member', roleIds: [], timeoutUntil: null, joinedAt: now });

    await r.listen(memberJoinedEvent(MEMBER, { joinedAt: now, at: now }));

    expect(r.patches()).toEqual([]);
    expect(r.k.timeouts.rows.get('Gone001')?.closeReason).toBe('removed_in_discord');
    expect(r.k.h.cancelled).toContainEqual({ jobId: TIMEOUT_JOB, naturalKey: MEMBER });
  });

  test('bots, and every join while moderation is off, are ignored', async () => {
    const r = rig();
    const now = r.now();
    await r.seed({ caseId: 'Bot0001', endsAt: now + HOUR, appliedUntil: now - MINUTE });

    await r.listen(memberJoinedEvent(MEMBER, { joinedAt: now, at: now, bot: true }));
    expect(r.patches()).toEqual([]);

    const off = rig({ enabled: false });
    await off.seed({ caseId: 'Off0001', endsAt: now + HOUR, appliedUntil: now - MINUTE });
    await off.listen(memberJoinedEvent(MEMBER, { joinedAt: now, at: now }));
    expect(off.patches()).toEqual([]);
  });
});

describe('a timeout changed by hand in Discord', () => {
  test('a removal by someone else closes the rows, cancels the job and tells the member', async () => {
    const r = rig({ punish: { notifications: { onUnpunishByOthers: true } } });
    const now = r.now();
    await r.seed({ caseId: 'Hand001', endsAt: now + HOUR, appliedUntil: now + HOUR });
    const event = timeoutAudit({ actorId: MODERATOR, newValue: null, reason: 'Served' }, now);

    await r.listen(event);

    expect(r.k.timeouts.rows.get('Hand001')).toMatchObject({
      closeReason: 'removed_in_discord',
      closedBy: MODERATOR,
    });
    expect(r.k.h.cancelled).toContainEqual({ jobId: TIMEOUT_JOB, naturalKey: MEMBER });

    const [dm] = r.k.h.dms();
    expect(dm?.userId).toBe(MEMBER);
    expect(dm?.message.embeds?.[0]?.title).toBe('Your timeout in Proton HQ has ended');
    expect(dm?.message.embeds?.[0]?.description).toBe('Served');

    const entryId = (event.payload as { entryId: string }).entryId;
    expect(r.k.h.keysUsed()).toContain(`${auditDmRoot(entryId)}:dm:send`);
    expect(r.patches()).toEqual([]);
  });

  test("Proton's own removal is not treated as someone else's", async () => {
    const r = rig({ punish: { notifications: { onUnpunishByOthers: true } } });
    const now = r.now();
    await r.seed({ caseId: 'Own0001', endsAt: now + HOUR, appliedUntil: now + HOUR });

    await r.listen(timeoutAudit({ actorId: BOT, newValue: null }, now));

    expect(r.k.timeouts.rows.get('Own0001')?.closedAt).toBeNull();
    expect(r.k.h.dms()).toHaveLength(0);
  });

  test('with the switch off the rows still close, but nobody is told', async () => {
    const r = rig();
    const now = r.now();
    await r.seed({ caseId: 'Hand002', endsAt: now + HOUR, appliedUntil: now + HOUR });

    await r.listen(timeoutAudit({ actorId: MODERATOR, newValue: null }, now));

    expect(r.k.timeouts.rows.get('Hand002')?.closeReason).toBe('removed_in_discord');
    expect(r.k.h.dms()).toHaveLength(0);
  });

  test('a timeout set by someone else is announced once, however often it is delivered', async () => {
    const r = rig({ punish: { notifications: { onPunishByOthers: true } } });
    const now = r.now();
    const event = timeoutAudit({ actorId: MODERATOR, newValue: iso(now + 2 * HOUR) }, now);

    await r.listen(event);
    await r.listen(event);

    const dms = r.k.h.dms();
    expect(dms).toHaveLength(1);
    expect(dms[0]?.message.embeds?.[0]?.title).toBe('You were timed out in Proton HQ');
    expect(dms[0]?.message.embeds?.[0]?.fields?.[0]?.value).toContain(
      String(Math.floor((now + 2 * HOUR) / 1000)),
    );
    expect(r.k.timeouts.rows.size).toBe(0);
  });
});

describe('bans, kicks and unbans by someone else', () => {
  test('a ban is announced once per audit entry, even when the event is redelivered', async () => {
    const r = rig({ punish: { notifications: { onPunishByOthers: true } } });
    const entryId = snowflake();
    const event = moderationAudit('member.banned', MODERATOR, entryId);

    await r.listen(event);
    await r.listen(event);

    const dms = r.k.h.dms();
    expect(dms).toHaveLength(1);
    expect(dms[0]?.message.embeds?.[0]?.title).toBe('You were banned from Proton HQ');
    expect(dms[0]?.message.embeds?.[0]?.description).toBe('Raiding');
    expect(r.k.h.keysUsed()).toEqual([
      `${auditDmRoot(entryId)}:dm:open`,
      `${auditDmRoot(entryId)}:dm:send`,
      `${auditDmRoot(entryId)}:dm:send`,
    ]);
  });

  test('a DM Discord refuses after a ban is recorded honestly', async () => {
    const r = rig({ punish: { notifications: { onPunishByOthers: true } } });
    r.k.h.rest.respond(
      SEND,
      discordError(400, 50278, 'Cannot send messages to this user due to having no mutual guilds'),
    );

    await r.listen(moderationAudit('member.kicked', MODERATOR));

    expect(r.k.h.dms()[0]?.status).toBe(400);
    expect(
      r.k.h.logs.some(
        (log) =>
          log.message.includes('could not tell') && log.message.includes('(no_mutual_server)'),
      ),
    ).toBe(true);
  });

  test('an unban by someone else uses the lifted switch', async () => {
    const lifted = rig({ punish: { notifications: { onUnpunishByOthers: true } } });
    await lifted.listen(moderationAudit('member.unbanned', MODERATOR));
    expect(lifted.k.h.dms()[0]?.message.embeds?.[0]?.title).toBe(
      'Your ban from Proton HQ was lifted',
    );

    const punishing = rig({ punish: { notifications: { onPunishByOthers: true } } });
    await punishing.listen(moderationAudit('member.unbanned', MODERATOR));
    expect(punishing.k.h.dms()).toHaveLength(0);
  });

  test("Proton's own bans, unknown actors and servers with the switch off get nothing", async () => {
    const r = rig({ punish: { notifications: { onPunishByOthers: true } } });
    await r.listen(moderationAudit('member.banned', BOT));
    await r.listen(moderationAudit('member.banned', null));
    expect(r.k.h.dms()).toHaveLength(0);

    const off = rig();
    await off.listen(moderationAudit('member.banned', MODERATOR));
    expect(off.k.h.dms()).toHaveLength(0);
  });

  test('without a bot user id it refuses to guess who acted', async () => {
    const r = rig({ punish: { notifications: { onPunishByOthers: true } } });
    const { botUserId: _unbound, ...deps } = r.k.deps;

    await r.k.h.listen(moderationAudit('member.banned', MODERATOR), createPunishListeners(deps), {
      configInput: { punish: { notifications: { onPunishByOthers: true } } },
      botPermissions: FULL_BOT,
      guildState: r.k.state,
    });

    expect(r.k.h.dms()).toHaveLength(0);
    expect(r.k.h.logs.some((log) => log.level === 'error')).toBe(true);
  });
});

describe('automatic punishments from elsewhere in Proton', () => {
  const ON_PUNISH = { punish: { notifications: { onPunish: true } } };

  test('an AutoMod timeout is announced after the fact, keyed on its case', async () => {
    const r = rig(ON_PUNISH);
    const until = r.now() + 10 * MINUTE;
    r.k.lookups.set(MEMBER, { state: 'member', roleIds: [], timeoutUntil: until, joinedAt: null });
    const event = actionExecutedEvent(
      {
        kind: 'timeout',
        moduleId: 'automod',
        actorId: 'proton:automod',
        caseId: 'Auto001',
        reason: 'Spam',
      },
      { at: r.now() },
    );

    await r.listen(event);
    await r.listen(event);

    const dms = r.k.h.dms();
    expect(dms).toHaveLength(1);
    expect(dms[0]?.channelId).toBe(DM_CHANNEL);
    expect(dms[0]?.message.embeds?.[0]?.title).toBe('You were timed out in Proton HQ');
    expect(dms[0]?.message.embeds?.[0]?.description).toBe('Spam');
    expect(dms[0]?.message.embeds?.[0]?.fields?.[0]?.value).toContain(
      String(Math.floor(until / 1000)),
    );
    expect(r.k.h.keysUsed()).toContain(`${caseDmRoot('Auto001')}:dm:send`);
  });

  test('warn escalation and AutoMod warnings are announced too', async () => {
    const r = rig(ON_PUNISH);
    r.k.lookups.set(MEMBER, {
      state: 'member',
      roleIds: [],
      timeoutUntil: r.now() + HOUR,
      joinedAt: null,
    });

    await r.listen(
      actionExecutedEvent({
        kind: 'timeout',
        moduleId: 'moderation',
        actorId: RULE_ENGINE_ACTOR,
        caseId: 'Esc0001',
      }),
    );
    await r.listen(
      actionExecutedEvent({
        kind: 'warn',
        moduleId: 'automod',
        actorId: 'proton:automod',
        caseId: 'Auto002',
      }),
    );

    expect(r.k.h.dms().map((dm) => dm.message.embeds?.[0]?.title)).toEqual([
      'You were timed out in Proton HQ',
      'You were warned in Proton HQ',
    ]);
  });

  test('other modules, other kinds and moderation’s own actions get nothing here', async () => {
    const r = rig(ON_PUNISH);

    await r.listen(actionExecutedEvent({ kind: 'ban', moduleId: 'honeypot', actorId: BOT }));
    await r.listen(
      actionExecutedEvent({ kind: 'ban', moduleId: 'automod', actorId: 'proton:automod' }),
    );
    await r.listen(
      actionExecutedEvent({ kind: 'kick', moduleId: 'moderation', actorId: RULE_ENGINE_ACTOR }),
    );
    await r.listen(
      actionExecutedEvent({ kind: 'timeout', moduleId: 'moderation', actorId: MODERATOR }),
    );
    await r.listen(actionExecutedEvent({ kind: 'timeout', moduleId: 'antiraid', actorId: BOT }));

    expect(r.k.h.dms()).toHaveLength(0);
  });

  test('a timeout that is already over is not announced, and a failed lookup is retried', async () => {
    const r = rig(ON_PUNISH);
    const automod = (caseId: string) =>
      actionExecutedEvent({
        kind: 'timeout',
        moduleId: 'automod',
        actorId: 'proton:automod',
        caseId,
      });

    await r.listen(automod('Over001'));
    expect(r.k.h.dms()).toHaveLength(0);
    expect(r.k.h.logs.some((log) => log.message.includes('already over'))).toBe(true);

    r.k.lookups.set(MEMBER, { state: 'unavailable', status: 502 });
    await expect(r.listen(automod('Over002'))).rejects.toThrow('Discord answered 502');
  });

  test('with the switch off nobody is told, but case history is still captured', async () => {
    const r = rig({ punish: { messageHistory: true } });
    await r.k.history.record(GUILD, {
      messageId: '1400000000000000009',
      channelId: CHANNEL,
      authorId: MEMBER,
      content: 'free nitro here',
      attachments: [],
      createdAt: r.now() - MINUTE,
      deletedAt: null,
    });

    await r.listen(
      actionExecutedEvent({
        kind: 'warn',
        moduleId: 'automod',
        actorId: 'proton:automod',
        caseId: 'Auto003',
      }),
    );

    expect(r.k.h.dms()).toHaveLength(0);
    expect(r.k.caseMessages.rows).toMatchObject([
      {
        caseId: 'Auto003',
        messageId: '1400000000000000009',
        content: 'free nitro here',
        proof: false,
      },
    ]);
  });

  test('a temporary ban lifting on its own is announced when the lifted switch is on', async () => {
    const r = rig({ punish: { notifications: { onUnpunish: true } } });

    await r.listen(
      actionExecutedEvent({
        kind: 'unban',
        moduleId: 'moderation',
        actorId: MODERATOR,
        caseId: 'Unban01',
        reason: 'Temporary ban expired.',
        reversal: true,
      }),
    );
    await r.listen(
      actionExecutedEvent({
        kind: 'unban',
        moduleId: 'honeypot',
        actorId: BOT,
        caseId: 'Unban02',
        reversal: true,
      }),
    );

    const dms = r.k.h.dms();
    expect(dms).toHaveLength(1);
    expect(dms[0]?.message.embeds?.[0]?.title).toBe('Your ban from Proton HQ was lifted');
    expect(r.k.h.keysUsed()).toContain(`${caseDmRoot('Unban01')}:dm:send`);
  });

  test('nothing is sent while moderation is off', async () => {
    const r = rig({ enabled: false, ...ON_PUNISH });

    await r.listen(
      actionExecutedEvent({ kind: 'timeout', moduleId: 'automod', actorId: 'proton:automod' }),
    );

    expect(r.k.h.dms()).toHaveLength(0);
  });
});

describe("tracking Proton's own automatic timeouts", () => {
  const MULTIPLE = { punish: { types: { timeout: { allowMultiple: true } } } };

  function escalation(caseId: string): ProtonEvent {
    return actionExecutedEvent({
      kind: 'timeout',
      moduleId: 'moderation',
      actorId: RULE_ENGINE_ACTOR,
      caseId,
    });
  }

  function held(r: ReturnType<typeof rig>, until: number | null): void {
    r.k.lookups.set(MEMBER, { state: 'member', roleIds: [], timeoutUntil: until, joinedAt: null });
  }

  test('a warn-escalation timeout gets its own row, so its end is logged like any other', async () => {
    const r = rig();
    const until = r.now() + HOUR;
    held(r, until);

    await r.listen(escalation('Esc0002'));
    await r.listen(escalation('Esc0002'));

    expect(r.k.timeouts.rows.get('Esc0002')).toMatchObject({
      endsAt: until,
      appliedUntil: until,
      closedAt: null,
    });
    expect(r.patches()).toEqual([]);
    expect(r.job()?.runAt.getTime()).toBe(until);
  });

  test('by default it replaces the earlier Proton timeout, as Discord already did', async () => {
    const r = rig();
    await r.seed({ caseId: 'Long011', endsAt: r.now() + 7 * DAY, appliedUntil: r.now() + 7 * DAY });
    held(r, r.now() + HOUR);

    await r.listen(escalation('Esc0003'));

    expect(r.k.timeouts.rows.get('Long011')?.closeReason).toBe('superseded');
    expect(r.patches()).toEqual([]);
  });

  test('with multiple timeouts allowed, the longer earlier timeout is put back', async () => {
    const r = rig(MULTIPLE);
    const longEnd = r.now() + 7 * DAY;
    await r.seed({ caseId: 'Long012', endsAt: longEnd, appliedUntil: longEnd });
    held(r, r.now() + HOUR);

    await r.listen(escalation('Esc0004'));
    await r.listen(escalation('Esc0004'));

    expect(r.patches()).toEqual([{ path: `/guilds/${GUILD}/members/${MEMBER}`, until: longEnd }]);
    expect(r.k.h.keysUsed()).toContain(`moderation:timeout:${GUILD}:${MEMBER}:reapply:Esc0004`);
    expect(r.k.h.cases()).toHaveLength(0);
    expect(r.k.timeouts.rows.get('Long012')?.closedAt).toBeNull();
    expect(r.k.timeouts.rows.get('Esc0004')?.appliedUntil).toBe(longEnd);
  });

  test('a timeout already over when the event arrives is not tracked', async () => {
    const r = rig();
    held(r, null);

    await r.listen(escalation('Esc0005'));

    expect(r.k.timeouts.rows.has('Esc0005')).toBe(false);
  });
});
