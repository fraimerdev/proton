import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import { sendPunishDm } from '../src/punish/dm.ts';
import {
  ABOVE_BOT,
  baseGuildState,
  DM_CHANNEL,
  discordError,
  LEFT_MEMBER,
  MEMBER,
} from './harness.ts';
import { callsTo, executed, FULL_BOT, kit, moderator, request } from './punish-kit.ts';

const DM_ON = { punish: { notifications: { onPunish: true } } };

function namedState() {
  const state = baseGuildState(FULL_BOT);
  state.name = 'Proton HQ';
  return state;
}

function dmKit(config: object = DM_ON) {
  return kit({ config, state: namedState() });
}

const OPEN = /^POST \/users\/@me\/channels$/;
const SEND = /^POST \/channels\/9\d+\/messages$/;

function order(k: ReturnType<typeof kit>): string[] {
  return k.h.rest.calls.map((call) => {
    const line = `${call.method} ${call.path}`;
    if (OPEN.test(line)) return 'open';
    if (SEND.test(line)) return 'dm';
    return line.replace(/\d{17,20}/g, ':id');
  });
}

describe('when the member is told', () => {
  test('a ban is announced before it lands, while there is still a shared server', async () => {
    const k = dmKit();

    const outcome = executed(await k.run(request('ban', { reason: 'Raiding' })));

    expect(order(k)).toEqual(['open', 'dm', 'PUT /guilds/:id/bans/:id']);
    expect(outcome.dm).toBe('sent');
    expect(outcome.summary).toContain('They were told by DM.');

    const [dm] = k.h.dms();
    expect(dm?.userId).toBe(MEMBER);
    expect(dm?.message.embeds?.[0]?.title).toBe('You were banned from Proton HQ');
    expect(dm?.message.embeds?.[0]?.description).toBe('Raiding');
    expect(dm?.message.embeds?.[0]?.fields).toEqual([
      { name: 'Duration', value: 'Permanent', inline: true },
    ]);
    expect(dm?.message.allowed_mentions).toEqual({ parse: [] });
    expect(k.h.keysUsed()).toEqual(['evt-1:dm:open', 'evt-1:dm:send', 'evt-1:action']);
  });

  test('a server that grants messaging only per channel still lets Proton send the DM', async () => {
    const state = baseGuildState(
      Permissions.BanMembers | Permissions.KickMembers | Permissions.ModerateMembers,
    );
    state.name = 'Proton HQ';
    const k = kit({ config: DM_ON, state });

    const outcome = executed(await k.run(request('ban', { reason: 'Raiding' })));

    expect(order(k)).toEqual(['open', 'dm', 'PUT /guilds/:id/bans/:id']);
    expect(outcome.dm).toBe('sent');
  });

  test('a kick is announced before it lands too', async () => {
    const k = dmKit();

    await k.run(request('kick'));

    expect(order(k)).toEqual(['open', 'dm', 'DELETE /guilds/:id/members/:id']);
  });

  test('a timeout is announced after it lands, with its end', async () => {
    const k = dmKit();

    const outcome = executed(await k.run(request('timeout', { duration: '2h' })));

    expect(order(k)).toEqual(['PATCH /guilds/:id/members/:id', 'open', 'dm']);
    const [dm] = k.h.dms();
    expect(dm?.message.embeds?.[0]?.title).toBe('You were timed out in Proton HQ');
    expect(dm?.message.embeds?.[0]?.fields?.[0]?.name).toBe('Until');
    expect(outcome.dm).toBe('sent');
  });

  test('a warning is announced after it is recorded', async () => {
    const k = dmKit();

    const outcome = executed(await k.run(request('warn', { reason: 'Be nice' })));

    expect(order(k)).toEqual(['open', 'dm']);
    expect(k.h.requests.map((entry) => entry.kind)).toEqual(['warn', 'create_dm', 'send']);
    expect(outcome.dm).toBe('sent');
  });

  test('a precheck refusal before a ban sends nothing, not even the direct message', async () => {
    const k = dmKit();

    const outcome = await k.run(request('ban', { targetId: ABOVE_BOT }));

    expect(outcome).toMatchObject({ status: 'failed', code: 'role_hierarchy' });
    expect(callsTo(k.h, OPEN)).toHaveLength(0);
    expect(k.h.dms()).toHaveLength(0);
  });

  test('notifications off sends nothing; notify overrides the setting either way', async () => {
    const off = kit({ state: namedState() });
    const quiet = executed(await off.run(request('warn')));
    expect(quiet.dm).toBe('skipped');
    expect(off.h.dms()).toHaveLength(0);

    const forced = executed(
      await off.run(request('warn', { idempotencyRoot: 'evt-2', notify: 'send' })),
    );
    expect(forced.dm).toBe('sent');

    const on = dmKit();
    const skipped = executed(await on.run(request('warn', { notify: 'skip' })));
    expect(skipped.dm).toBe('skipped');
    expect(on.h.dms()).toHaveLength(0);
  });
});

describe('a direct message that fails', () => {
  test('closed DMs never block the ban, and the moderator is told', async () => {
    const k = dmKit();
    k.h.rest.respond(SEND, discordError(403, 50007, 'Cannot send messages to this user'));

    const outcome = executed(await k.run(request('ban')));

    expect(outcome.dm).toBe('closed');
    expect(outcome.summary).toContain('their DMs are closed');
    expect(callsTo(k.h, /^PUT \/guilds\/\d+\/bans\//)).toHaveLength(1);
  });

  test('a DM that cannot even be opened never blocks a timeout', async () => {
    const k = dmKit();
    k.h.rest.respond(OPEN, discordError(403, 50007, 'Cannot send messages to this user'));

    const outcome = executed(await k.run(request('timeout')));

    expect(outcome.dm).toBe('closed');
    expect(outcome.caseId).not.toBeNull();
  });

  test('a user who shares no server with Proton is not said to have closed their DMs', async () => {
    const k = dmKit();
    k.h.rest.respond(
      SEND,
      discordError(400, 50278, 'Cannot send messages to this user due to having no mutual guilds'),
    );

    const outcome = executed(await k.run(request('ban', { targetId: LEFT_MEMBER })));

    expect(outcome.dm).toBe('no_mutual_server');
    expect(outcome.summary).toContain(
      "They weren't told because they no longer share a server with Proton.",
    );
    expect(outcome.summary).not.toContain('closed');
  });

  test('any other refusal is reported as failed, not closed', async () => {
    const k = dmKit();
    k.h.rest.respond(SEND, discordError(500, 0, 'Internal error'));

    const outcome = executed(await k.run(request('warn')));

    expect(outcome.dm).toBe('failed');
    expect(outcome.summary).toContain("the DM didn't go through");
  });

  test('a ban that fails after the DM went out sends a correction', async () => {
    const k = dmKit();
    k.h.rest.respond(/^PUT \/guilds\/\d+\/bans\//, discordError(403, 50013, 'Missing Permissions'));

    const outcome = await k.run(request('ban'));

    expect(outcome).toMatchObject({ status: 'failed', code: 'discord_403' });
    const dms = k.h.dms();
    expect(dms).toHaveLength(2);
    expect(dms[1]?.message.content).toBe(
      "Ignore the previous message about Proton HQ. That ban didn't go through.",
    );
    expect(k.h.keysUsed()).toContain('evt-1:dm:correction');
    expect(callsTo(k.h, OPEN)).toHaveLength(1);
  });

  test('a retry on the same root after a correction never claims the member was told', async () => {
    const k = dmKit();
    k.h.rest.respond(/^PUT \/guilds\/\d+\/bans\//, discordError(500, 0, 'Internal error'), {
      times: 1,
    });
    const root = 'moderation:report:R1:accept';

    expect(await k.run(request('ban', { idempotencyRoot: root }))).toMatchObject({
      status: 'failed',
    });
    const retried = executed(await k.run(request('ban', { idempotencyRoot: root })));

    expect(k.h.dms().map((dm) => dm.message.content ?? dm.message.embeds?.[0]?.title)).toEqual([
      'You were banned from Proton HQ',
      "Ignore the previous message about Proton HQ. That ban didn't go through.",
    ]);
    expect(retried.dm).toBe('not_sent');
    expect(retried.summary).not.toContain('They were told');
  });

  test('a retry with its own DM root tells the member again, and says so', async () => {
    const k = dmKit();
    k.h.rest.respond(/^PUT \/guilds\/\d+\/bans\//, discordError(500, 0, 'Internal error'), {
      times: 1,
    });
    const root = 'moderation:report:R1:accept';

    await k.run(request('ban', { idempotencyRoot: root, dmRoot: `${root}:token-a` }));
    const retried = executed(
      await k.run(request('ban', { idempotencyRoot: root, dmRoot: `${root}:token-b` })),
    );

    expect(k.h.dms()).toHaveLength(3);
    expect(k.h.dms()[2]?.message.embeds?.[0]?.title).toBe('You were banned from Proton HQ');
    expect(retried.dm).toBe('sent');
    expect(retried.summary).toContain('They were told by DM.');
    expect(k.h.keysUsed()).toEqual(
      expect.arrayContaining([
        `${root}:token-a:dm:send`,
        `${root}:token-a:dm:correction`,
        `${root}:token-b:dm:send`,
        `${root}:action`,
      ]),
    );
  });

  test('no correction is sent when the first message never arrived', async () => {
    const k = dmKit();
    k.h.rest.respond(SEND, discordError(403, 50007, 'Cannot send messages to this user'), {
      times: 1,
    });
    k.h.rest.respond(/^PUT \/guilds\/\d+\/bans\//, discordError(403, 50013, 'Missing Permissions'));

    await k.run(request('ban'));

    expect(k.h.keysUsed()).not.toContain('evt-1:dm:correction');
  });
});

describe('the remembered DM channel', () => {
  const input = {
    direction: 'warn' as const,
    userId: MEMBER,
    root: 'evt-9',
    actor: moderator(),
    reason: 'Be nice',
    durationMs: null,
    expiresAt: null,
    caseId: null,
  };

  test('a retry after a failed send reuses the channel, so the duplicate open is never needed', async () => {
    const k = dmKit();
    k.h.rest.respond(SEND, discordError(500, 0, 'Internal error'), { times: 1 });

    expect((await sendPunishDm(k.ctx(), k.deps, input)).outcome).toBe('failed');
    const retried = await sendPunishDm(k.ctx(), k.deps, input);

    expect(retried).toEqual({ outcome: 'sent', channelId: DM_CHANNEL });
    expect(callsTo(k.h, OPEN)).toHaveLength(1);
  });

  test('without a store, a duplicate open cannot be sent through and says so', async () => {
    const k = dmKit();
    const { dmChannels: _unbound, ...deps } = k.deps;
    k.h.rest.respond(SEND, discordError(500, 0, 'Internal error'), { times: 1 });

    await sendPunishDm(k.ctx(), deps, input);
    const retried = await sendPunishDm(k.ctx(), deps, input);

    expect(retried.outcome).toBe('gave_up');
  });
});
