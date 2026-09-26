import { describe, expect, test } from 'bun:test';
import {
  MODERATION_ACTION_KINDS,
  type ModerationActionKind,
  type ProtonEvent,
  type UserProfile,
  type UserResolver,
} from '@proton/core';
import { AuditLogEvent } from 'discord-api-types/v10';
import { specForAction } from '../src/catalogue.ts';
import { ServerLogColors } from '../src/colours.ts';
import { serverlogDefaultConfig } from '../src/config.ts';
import {
  createServerlogListener,
  type FlushRequest,
  flushPending,
  logIdempotencyKey,
  type ServerlogDeps,
} from '../src/listeners.ts';
import {
  ACTOR,
  auditEvent,
  BOT_USER,
  config,
  context,
  EMOJIS,
  event,
  GUILD,
  MemoryCorrelationStore,
  RecordingExecutor,
} from './harness.ts';

const TARGET = '100000000000000007';
const REPORTER = '200000000000000012';
const CLOSER = '200000000000000013';
const MODERATION_CHANNEL = '500000000000000041';
const PROTON_CHANNEL = '500000000000000042';
const EVENT_CHANNEL = '500000000000000043';
const OCCURRED_AT = 1_700_000_000_000;

const NAMES: Record<string, string> = {
  [ACTOR]: 'solus',
  [BOT_USER]: 'Proton',
  [REPORTER]: 'reporter',
  [CLOSER]: 'closer',
};

function namedResolver(asked: string[] = []): UserResolver {
  return {
    async resolve(userId: string): Promise<UserProfile | null> {
      asked.push(userId);
      return {
        id: userId,
        username: NAMES[userId] ?? `user-${userId}`,
        globalName: null,
        avatarUrl: null,
        avatarHash: null,
      };
    },
  };
}

function build(botUserId: string | null = BOT_USER) {
  const asked: string[] = [];
  const flushes: FlushRequest[] = [];
  const correlation = new MemoryCorrelationStore();
  const deps: ServerlogDeps = {
    correlation,
    users: namedResolver(asked),
    emojis: EMOJIS,
    ...(botUserId ? { botUserId } : {}),
    scheduleFlush: async (request) => {
      flushes.push(request);
    },
  };

  return { asked, correlation, deps, flushes, listener: createServerlogListener(deps) };
}

const routed = (overrides: Parameters<typeof config>[0] = {}) =>
  config({
    categoryChannels: {
      ...serverlogDefaultConfig.categoryChannels,
      moderation: MODERATION_CHANNEL,
      proton: PROTON_CHANNEL,
    },
    ...overrides,
  });

function action(overrides: Record<string, unknown> = {}): ProtonEvent {
  const payload = {
    caseId: 'z2LcQRB',
    guildId: GUILD,
    moduleId: 'moderation',
    kind: 'kick',
    actorId: ACTOR,
    targetId: TARGET,
    reason: 'spamming',
    dryRun: false,
    expiresAt: null,
    ...overrides,
  };

  return {
    id: `proton.action_executed:${GUILD}:${payload.caseId}`,
    type: 'proton.action_executed',
    guildId: GUILD,
    occurredAt: OCCURRED_AT,
    payload,
  };
}

function protonEvent(type: ProtonEvent['type'], payload: unknown): ProtonEvent {
  return { id: `${type}:1`, type, guildId: GUILD, occurredAt: OCCURRED_AT, payload };
}

async function post(events: ProtonEvent[], cfg = routed(), deps = build()) {
  const executor = new RecordingExecutor();
  const ctx = context(executor, cfg);

  for (const next of events) await deps.listener.handler(next, ctx);

  return executor;
}

async function settle(events: ProtonEvent[], cfg = routed(), setup = build()) {
  const executor = new RecordingExecutor();
  const ctx = context(executor, cfg);

  for (const next of events) await setup.listener.handler(next, ctx);
  for (const request of setup.flushes.splice(0)) await flushPending(setup.deps, ctx, request);

  return executor;
}

function leaveOf(userId: string): ProtonEvent {
  const leave = event('guildMemberAdd');
  leave.type = 'member.left';
  (leave.payload as { user: { id: string } }).user.id = userId;
  return leave;
}

function body(executor: RecordingExecutor): string {
  return String(executor.embeds()[0]?.description);
}

const LOOKS: Array<[ModerationActionKind, string, number]> = [
  ['ban', 'Member banned', ServerLogColors.Remove],
  ['unban', 'Member unbanned', ServerLogColors.Add],
  ['kick', 'Member kicked', ServerLogColors.Remove],
  ['timeout', 'Member timed out', ServerLogColors.Modify],
  ['untimeout', 'Timeout removed', ServerLogColors.Modify],
  ['warn', 'Member warned', ServerLogColors.Modify],
  ['unwarn', 'Warning removed', ServerLogColors.Add],
  ['purge', 'Messages purged', ServerLogColors.Remove],
  ['slowmode', 'Slowmode changed', ServerLogColors.Modify],
  ['lockdown', 'Channel locked', ServerLogColors.Remove],
  ['unlock', 'Channel unlocked', ServerLogColors.Add],
];

describe('routing', () => {
  test.each([...MODERATION_ACTION_KINDS])(
    'a %s Proton performed goes to the moderation channel',
    async (kind) => {
      const executor = await post([action({ kind })]);

      expect(executor.channels()).toEqual([MODERATION_CHANNEL]);
    },
  );

  test('an action that is not moderation stays in the Proton channel', async () => {
    const executor = await post([
      action({ kind: 'add_role', actorId: 'proton:joinroles', moduleId: 'joinroles' }),
    ]);

    expect(executor.channels()).toEqual([PROTON_CHANNEL]);
    expect(executor.titles()).toEqual(['Proton added a role']);
  });

  test('a moderation action is posted once, never also as a Proton action', async () => {
    const executor = await post([action({ kind: 'ban' })]);

    expect(executor.requests).toHaveLength(1);
  });

  test('the moderation category off silences them, the Proton category off does not', async () => {
    const moderationOff = await post(
      [action()],
      routed({ categories: { ...serverlogDefaultConfig.categories, moderation: false } }),
    );
    const protonOff = await post(
      [action()],
      routed({ categories: { ...serverlogDefaultConfig.categories, proton: false } }),
    );

    expect(moderationOff.requests).toEqual([]);
    expect(protonOff.channels()).toEqual([MODERATION_CHANNEL]);
  });

  test('the Member banned override governs Proton’s bans too, both ways', async () => {
    const off = await post(
      [action({ kind: 'ban' })],
      routed({ events: { 'moderation.member_banned': { enabled: false } } }),
    );
    const elsewhere = await post(
      [action({ kind: 'ban' })],
      routed({ events: { 'moderation.member_banned': { channelId: EVENT_CHANNEL } } }),
    );

    expect(off.requests).toEqual([]);
    expect(elsewhere.channels()).toEqual([EVENT_CHANNEL]);
  });

  test('an ignored moderator’s actions are skipped, like their audit entries', async () => {
    const executor = await post([action()], routed({ ignoredUserIds: [ACTOR] }));

    expect(executor.requests).toEqual([]);
  });

  test('a rehearsal is not logged as if it happened', async () => {
    const executor = await post([action({ dryRun: true })]);

    expect(executor.requests).toEqual([]);
  });

  test('a redelivered action reuses its idempotency key and records no case', async () => {
    const executor = await post([action(), action()]);
    const key = logIdempotencyKey(GUILD, 'moderation.member_kicked', action().id);

    expect(executor.requests.map((request) => request.idempotencyKey)).toEqual([key, key]);
    expect(executor.requests.every((request) => request.record === false)).toBe(true);
  });
});

describe('the look matches the audit-based entries', () => {
  test.each(LOOKS)('%s is titled %s', async (kind, title, colour) => {
    const executor = await post([action({ kind })]);

    expect(executor.titles()).toEqual([title]);
    expect(executor.embeds()[0]?.color).toBe(colour);
    expect(specForAction(kind)?.label).toBe(title);
    expect(specForAction(kind)?.category).toBe('moderation');
  });

  test('a kick Proton performed looks like a kick done in Discord', async () => {
    const viaProton = await post([action()]);
    const inDiscord = await post([
      auditEvent(AuditLogEvent.MemberKick, { target_id: TARGET, reason: 'spamming' }),
    ]);

    expect(viaProton.titles()).toEqual(inDiscord.titles());
    expect(viaProton.embeds()[0]?.color).toBe(inDiscord.embeds()[0]?.color ?? -1);
  });

  test('names the member, the moderator, the reason and the case', async () => {
    const text = body(await post([action()]));

    expect(text).toContain(`**Member:** <@${TARGET}> \`${TARGET}\``);
    expect(text).toContain(`**Moderator:** <@${ACTOR}> \`${ACTOR}\``);
    expect(text).toContain('**Reason:** `spamming`');
    expect(text).toContain('**Case:** `z2LcQRB`');
  });

  test('an automatic action names Proton and the module, never a fake mention', async () => {
    const text = body(
      await post([action({ kind: 'ban', actorId: 'proton:antinuke', moduleId: 'antinuke' })]),
    );

    expect(text).toContain('**Moderator:** `Proton · Anti-Nuke`');
    expect(text).not.toContain('<@proton:');
  });

  test('a rule’s action is automatic too', async () => {
    const text = body(
      await post([action({ kind: 'timeout', actorId: 'proton:rule-engine', moduleId: 'automod' })]),
    );

    expect(text).toContain('**Moderator:** `Proton · Automod`');
  });

  test('a module Proton has no name for is shown by its id', async () => {
    const text = body(await post([action({ actorId: 'rules:custom', moduleId: 'custom' })]));

    expect(text).toContain('**Moderator:** `Proton · custom`');
  });

  test('no reason is said plainly', async () => {
    expect(body(await post([action({ reason: null })]))).toContain('**Reason:** `No reason given`');
  });

  test('a temporary ban says when it ends', async () => {
    const text = body(await post([action({ kind: 'ban', expiresAt: 1_700_604_800_000 })]));

    expect(text).toContain('**Until:** <t:1700604800:F>');
  });

  test('a timeout says when it ends', async () => {
    const text = body(await post([action({ kind: 'timeout', until: 1_700_003_600_000 })]));

    expect(text).toContain('**Until:** <t:1700003600:F>');
  });

  test('a timeout without an end on the event has no Until line', async () => {
    const text = body(await post([action({ kind: 'timeout' })]));

    expect(text).not.toContain('Until');
  });

  test('a permanent ban has no Until line', async () => {
    expect(body(await post([action({ kind: 'ban' })]))).not.toContain('Until');
  });

  test('a channel action names no member', async () => {
    const text = body(await post([action({ kind: 'slowmode', targetId: null })]));

    expect(text).not.toContain('Member');
    expect(text).toContain(`**Moderator:** <@${ACTOR}>`);
  });

  test('a slowmode names the channel and the new wait', async () => {
    const text = body(
      await post([
        action({ kind: 'slowmode', targetId: null, channelId: EVENT_CHANNEL, seconds: 30 }),
      ]),
    );

    expect(text).toContain(`**Channel:** <#${EVENT_CHANNEL}> \`${EVENT_CHANNEL}\``);
    expect(text).toContain('**Slowmode:** `30s`');
  });

  test('a slowmode switched off says Off', async () => {
    const text = body(
      await post([
        action({ kind: 'slowmode', targetId: null, channelId: EVENT_CHANNEL, seconds: 0 }),
      ]),
    );

    expect(text).toContain('**Slowmode:** `Off`');
  });

  test.each(['purge', 'lockdown', 'unlock'] as const)(
    'a %s names the channel it touched and nothing about slowmode',
    async (kind) => {
      const text = body(await post([action({ kind, targetId: null, channelId: EVENT_CHANNEL })]));

      expect(text).toContain(`**Channel:** <#${EVENT_CHANNEL}>`);
      expect(text).not.toContain('Slowmode:');
    },
  );

  test('two channels locked read as two different entries', async () => {
    const first = body(
      await post([action({ kind: 'lockdown', targetId: null, channelId: EVENT_CHANNEL })]),
    );
    const second = body(
      await post([action({ kind: 'lockdown', targetId: null, channelId: PROTON_CHANNEL })]),
    );

    expect(first).not.toBe(second);
  });

  test('a channel action without its channel on the event has no Channel line', async () => {
    const text = body(await post([action({ kind: 'lockdown', targetId: null })]));

    expect(text).not.toContain('Channel:');
  });

  test('mentions in the log never ping', async () => {
    const executor = await post([action()]);

    expect(executor.payloads()[0]?.allowedMentions).toEqual({ parse: [] });
  });
});

describe('reversals', () => {
  const lifted = () =>
    action({
      caseId: 'Rv7Qm2P',
      kind: 'unban',
      reversal: true,
      reason: 'Temporary ban expired.',
      expiresAt: 1_700_604_800_000,
    });

  test('a temporary ban running out is logged as the unban, ended automatically', async () => {
    const executor = await post([lifted()]);
    const text = body(executor);

    expect(executor.titles()).toEqual(['Member unbanned']);
    expect(executor.channels()).toEqual([MODERATION_CHANNEL]);
    expect(text).toContain('**Moderator:** `Ended automatically`');
    expect(text).toContain('**Reason:** `Temporary ban expired.`');
    expect(text).toContain('**Case:** `Rv7Qm2P`');
    expect(text).not.toContain(`<@${ACTOR}>`);
    expect(text).not.toContain('Until');
  });

  test('the footer is Proton, not the moderator who set the ban', async () => {
    expect((await post([lifted()])).footers()).toEqual(['Proton']);
  });

  test('a lockdown running out is logged as the unlock', async () => {
    const executor = await post([action({ kind: 'unlock', targetId: null, reversal: true })]);

    expect(executor.titles()).toEqual(['Channel unlocked']);
    expect(body(executor)).toContain('`Ended automatically`');
  });
});

describe('the footer shows who acted', () => {
  test('a moderator’s action carries the moderator', async () => {
    expect((await post([action()])).footers()).toEqual(['solus']);
  });

  test('an automatic action carries Proton', async () => {
    const setup = build();
    const executor = await post(
      [action({ actorId: 'proton:antinuke', moduleId: 'antinuke' })],
      routed(),
      setup,
    );

    expect(executor.footers()).toEqual(['Proton']);
    expect(setup.asked).toEqual([BOT_USER]);
  });

  test('without Proton’s own user id an automatic action is Unknown, not a pseudo id', async () => {
    const setup = build(null);
    const executor = await post([action({ actorId: 'proton:antinuke' })], routed(), setup);

    expect(executor.footers()).toEqual(['Unknown']);
    expect(setup.asked).toEqual([]);
  });

  test('a non-moderation action carries its actor too', async () => {
    const executor = await post([action({ kind: 'add_role', actorId: ACTOR })]);

    expect(executor.footers()).toEqual(['solus']);
  });

  const report = {
    guildId: GUILD,
    reportId: 'Xk3P9aQ',
    number: 12,
    reporterId: REPORTER,
    targetId: TARGET,
  };

  test('a report filed carries the reporter', async () => {
    const executor = await post([
      protonEvent('moderation.report_submitted', {
        ...report,
        method: 'command',
        reason: 'Harassment',
        channelId: null,
        messageId: null,
        createdAt: OCCURRED_AT,
      }),
    ]);

    expect(executor.footers()).toEqual(['reporter']);
  });

  const resolved = {
    ...report,
    status: 'accepted' as const,
    resolvedBy: ACTOR,
    actionKind: 'ban',
    caseIds: ['Ab12Cd3'],
    resolvedAt: OCCURRED_AT,
  };

  test('a report resolved carries whoever decided it', async () => {
    const executor = await post([protonEvent('moderation.report_resolved', resolved)]);

    expect(executor.footers()).toEqual(['solus']);
  });

  test('a report resolved by automation carries Proton', async () => {
    const executor = await post([
      protonEvent('moderation.report_resolved', { ...resolved, resolvedBy: 'proton:reports' }),
    ]);

    expect(executor.footers()).toEqual(['Proton']);
  });

  test('a settings change carries the admin', async () => {
    const executor = await post([
      protonEvent('proton.config_changed', {
        auditId: 'audit-1',
        guildId: GUILD,
        moduleId: 'joinroles',
        moduleName: 'Join roles',
        actorId: ACTOR,
        source: 'dashboard',
        enabledBefore: false,
        enabledAfter: true,
        changedKeys: ['memberRoleIds'],
      }),
    ]);

    expect(executor.footers()).toEqual(['solus', 'solus']);
  });

  test('a command settings change carries the admin', async () => {
    const executor = await post([
      protonEvent('proton.commands_changed', {
        auditId: 'audit-2',
        guildId: GUILD,
        actorId: ACTOR,
        source: 'dashboard',
        key: 'ban',
        displayName: 'ban',
        newName: 'punish',
        changed: ['name'],
        enabledBefore: true,
        enabledAfter: true,
        registration: true,
      }),
    ]);

    expect(executor.footers()).toEqual(['solus']);
    expect(executor.channels()).toEqual([PROTON_CHANNEL]);
  });

  test('a timeout running out carries Proton', async () => {
    const executor = await post([
      protonEvent('moderation.punishment_expired', {
        guildId: GUILD,
        caseId: 'Qm4T7zR',
        kind: 'timeout',
        userId: TARGET,
        endedAt: OCCURRED_AT,
        memberPresent: true,
      }),
    ]);

    expect(executor.footers()).toEqual(['Proton']);
  });

  test('a security trip carries Proton, not the member who tripped it', async () => {
    const executor = await post([
      protonEvent('proton.security_tripped', {
        guildId: GUILD,
        moduleId: 'antinuke',
        trigger: 'channelDelete',
        actorId: ACTOR,
        summary: 'four channels were deleted in ten seconds',
        actionsTaken: [],
        ownerExempt: false,
      }),
    ]);

    expect(executor.footers()).toEqual(['Proton']);
  });

  test('a ticket closed carries whoever closed it', async () => {
    const executor = await post([
      protonEvent('tickets.closed', {
        guildId: GUILD,
        ticketId: 'ticket-1',
        number: 4,
        channelId: '500000000000000050',
        typeId: 'support',
        typeName: 'Support',
        openerId: TARGET,
        closedById: CLOSER,
        reason: null,
        openedAt: OCCURRED_AT - 60_000,
        closedAt: OCCURRED_AT,
        messageCount: 3,
      }),
    ]);

    expect(executor.footers()).toEqual(['closer']);
  });

  test('a scheduled giveaway starting carries Proton', async () => {
    const executor = await post([
      protonEvent('giveaways.started', {
        guildId: GUILD,
        giveawayId: 'giveaway-1',
        shortCode: '7X29',
        title: 'Discord Nitro',
        channelId: '500000000000000010',
        hostId: ACTOR,
        endsAt: OCCURRED_AT + 60_000,
      }),
    ]);

    expect(executor.footers()).toEqual(['Proton']);
  });
});

describe('Proton’s own moderation is logged once', () => {
  const protonAudit = (actionType: number, overrides: Record<string, unknown> = {}) =>
    auditEvent(actionType, { user_id: BOT_USER, target_id: TARGET, ...overrides });

  test('a /kick posts one Member kicked, attributed to the moderator', async () => {
    const executor = await post([protonAudit(AuditLogEvent.MemberKick), action()]);

    expect(executor.titles()).toEqual(['Member kicked']);
    expect(executor.channels()).toEqual([MODERATION_CHANNEL]);
    expect(executor.footers()).toEqual(['solus']);
  });

  test('a /timeout posts one Member timed out', async () => {
    const executor = await post([
      protonAudit(AuditLogEvent.MemberUpdate, {
        changes: [{ key: 'communication_disabled_until', new_value: '2026-08-16T13:00:00.000Z' }],
      }),
      action({ kind: 'timeout', until: 1_700_003_600_000 }),
    ]);

    expect(executor.titles()).toEqual(['Member timed out']);
    expect(executor.footers()).toEqual(['solus']);
  });

  test('a /ban posts one Member banned when the audit entry arrives first', async () => {
    const executor = await settle([
      protonAudit(AuditLogEvent.MemberBanAdd),
      event('guildBanAdd'),
      action({ kind: 'ban' }),
    ]);

    expect(executor.titles()).toEqual(['Member banned']);
    expect(executor.footers()).toEqual(['solus']);
  });

  test('a /ban posts one Member banned when the ban arrives first', async () => {
    const executor = await settle([
      event('guildBanAdd'),
      protonAudit(AuditLogEvent.MemberBanAdd),
      action({ kind: 'ban' }),
    ]);

    expect(executor.titles()).toEqual(['Member banned']);
    expect(executor.footers()).toEqual(['solus']);
  });

  test('a /ban read in one batch with its leave posts one Member banned', async () => {
    const executor = await settle([
      protonAudit(AuditLogEvent.MemberBanAdd),
      leaveOf(TARGET),
      event('guildBanAdd'),
      action({ kind: 'ban' }),
    ]);

    expect(executor.titles()).toEqual(['Member banned']);
    expect(executor.channels()).toEqual([MODERATION_CHANNEL]);
    expect(executor.footers()).toEqual(['solus']);
  });

  test('a /ban whose action is read before Discord’s events posts one Member banned', async () => {
    const executor = await settle([
      action({ kind: 'ban' }),
      protonAudit(AuditLogEvent.MemberBanAdd),
      leaveOf(TARGET),
      event('guildBanAdd'),
    ]);

    expect(executor.titles()).toEqual(['Member banned']);
  });

  test('a /ban whose audit entry is late posts one Member banned', async () => {
    const executor = await settle([event('guildBanAdd'), action({ kind: 'ban' })]);

    expect(executor.titles()).toEqual(['Member banned']);
    expect(executor.footers()).toEqual(['solus']);
  });

  test('an ignored moderator’s ban does not come back through Discord’s ban event', async () => {
    const executor = await settle(
      [protonAudit(AuditLogEvent.MemberBanAdd), event('guildBanAdd'), action({ kind: 'ban' })],
      routed({ ignoredUserIds: [ACTOR] }),
    );

    expect(executor.requests).toEqual([]);
  });

  test('a /ban remove posts one Member unbanned', async () => {
    const executor = await settle([
      protonAudit(AuditLogEvent.MemberBanRemove),
      event('guildBanRemove'),
      action({ kind: 'unban' }),
    ]);

    expect(executor.titles()).toEqual(['Member unbanned']);
    expect(executor.footers()).toEqual(['solus']);
  });

  test('an unban Proton recorded no case for is still logged, from its audit entry', async () => {
    const executor = await settle([
      protonAudit(AuditLogEvent.MemberBanRemove, { reason: 'Honeypot softban' }),
      event('guildBanRemove'),
    ]);

    expect(executor.titles()).toEqual(['Member unbanned']);
    expect(executor.channels()).toEqual([MODERATION_CHANNEL]);
    expect(executor.footers()).toEqual(['Proton']);
    expect(body(executor)).toContain('**Reason:** `Honeypot softban`');
  });

  test('the same unban is logged when Discord’s event arrives before the audit entry', async () => {
    const executor = await settle([
      event('guildBanRemove'),
      protonAudit(AuditLogEvent.MemberBanRemove, { reason: 'Honeypot softban' }),
    ]);

    expect(executor.titles()).toEqual(['Member unbanned']);
    expect(executor.footers()).toEqual(['Proton']);
  });

  test('a softban logs the ban from its case and the unban from Discord', async () => {
    const executor = await settle([
      protonAudit(AuditLogEvent.MemberBanAdd),
      leaveOf(TARGET),
      event('guildBanAdd'),
      action({ kind: 'ban', actorId: 'proton:honeypot', moduleId: 'honeypot' }),
      protonAudit(AuditLogEvent.MemberBanRemove),
      event('guildBanRemove'),
    ]);

    expect(executor.titles()).toEqual(['Member banned', 'Member unbanned']);
  });

  test('a ban done in Discord read in one batch with its leave names who did it and why', async () => {
    const executor = await settle([
      auditEvent(AuditLogEvent.MemberBanAdd, { target_id: TARGET, reason: 'raiding' }),
      leaveOf(TARGET),
      event('guildBanAdd'),
    ]);

    expect(executor.titles()).toEqual(['Member banned']);
    expect(executor.footers()).toEqual(['solus']);
    expect(body(executor)).toContain('**Reason:** `raiding`');
  });

  test('a leave read before its ban’s audit entry is not logged as a leave', async () => {
    const executor = await settle([
      leaveOf(TARGET),
      auditEvent(AuditLogEvent.MemberBanAdd, { target_id: TARGET }),
      event('guildBanAdd'),
    ]);

    expect(executor.titles()).toEqual(['Member banned']);
  });

  test('a voluntary leave is still logged once the window passes', async () => {
    const executor = await settle([leaveOf(TARGET)]);

    expect(executor.titles()).toEqual(['Member left']);
  });

  test('a ban done in Discord still logs when the ban arrives before its audit entry', async () => {
    const executor = await post([
      event('guildBanAdd'),
      auditEvent(AuditLogEvent.MemberBanAdd, { target_id: TARGET }),
    ]);

    expect(executor.titles()).toEqual(['Member banned']);
    expect(executor.footers()).toEqual(['solus']);
  });

  test('a ban done in Discord still logs when its audit entry arrives first', async () => {
    const executor = await post([
      auditEvent(AuditLogEvent.MemberBanAdd, { target_id: TARGET }),
      event('guildBanAdd'),
    ]);

    expect(executor.titles()).toEqual(['Member banned']);
    expect(executor.footers()).toEqual(['solus']);
  });

  test('the leave that follows a ban is not logged on top of it', async () => {
    const leave = event('guildMemberAdd');
    leave.type = 'member.left';
    (leave.payload as { user: { id: string } }).user.id = TARGET;

    const setup = build();
    const executor = await post(
      [event('guildBanAdd'), auditEvent(AuditLogEvent.MemberBanAdd, { target_id: TARGET }), leave],
      routed(),
      setup,
    );

    expect(executor.titles()).toEqual(['Member banned']);
    expect(setup.correlation.pendings.size).toBe(0);
  });

  test('a role Proton changed is still not logged from its audit entry', async () => {
    const executor = await post([
      protonAudit(AuditLogEvent.MemberRoleUpdate, {
        changes: [{ key: '$add', new_value: [{ id: '700000000000000001', name: 'Member' }] }],
      }),
    ]);

    expect(executor.requests).toEqual([]);
  });
});
