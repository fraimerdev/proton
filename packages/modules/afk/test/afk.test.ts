import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import {
  AFK_EXPIRE_JOB,
  AFK_RETENTION_MS,
  AFK_TIDY_JOB,
  AFK_TOMBSTONE_MS,
  NOTICE_COOLDOWN_MS,
} from '../src/config.ts';
import { REASON_HAS_LINK, REASON_TOO_LONG } from '../src/reason.ts';
import type { AfkStatus } from '../src/store.ts';
import {
  ABOVE_BOT,
  APPLICATION_ID,
  BOT_PERMISSIONS,
  CHANNEL,
  type CommandOverrides,
  configChanged,
  DM_CHANNEL,
  GUILD,
  type Harness,
  harness,
  MEMBER,
  MemoryAfkStore,
  memberLeft,
  mention,
  messageEvent,
  messageIdOf,
  OTHER,
  OWNER,
  QUIET_CHANNEL,
  STAFF,
  snowflake,
  stringOption,
  THREAD,
  userOption,
} from './harness.ts';

async function goAfk(
  h: Harness,
  reason?: string,
  overrides: Partial<CommandOverrides> = {},
): Promise<AfkStatus> {
  await h.run('set', reason === undefined ? [] : [stringOption('reason', reason)], overrides);

  const status = await h.store.get(GUILD, overrides.userId ?? MEMBER);
  if (!status) throw new Error(`the AFK status was not stored: ${h.lastFollowUp()}`);
  return status;
}

function sinceTag(status: AfkStatus): string {
  return `<t:${Math.floor(status.since.getTime() / 1000)}:R>`;
}

function nextBucket(): number {
  return (Math.floor(Date.now() / NOTICE_COOLDOWN_MS) + 1) * NOTICE_COOLDOWN_MS;
}

function warnings(h: Harness): string[] {
  return h.logs.filter((log) => log.level === 'warn').map((log) => log.message);
}

async function endedRecord(h: Harness, userId = MEMBER): Promise<AfkStatus> {
  const status = await h.store.get(GUILD, userId);
  if (!status?.endedAt) throw new Error('the AFK status was not kept as an ended record');

  expect(status).toMatchObject({ reason: null, previousNick: null, appliedNick: null });
  return status;
}

function expiries(h: Harness) {
  return h.scheduler.booked.filter((job) => job.jobId === AFK_EXPIRE_JOB);
}

describe('/afk set', () => {
  test('defers before it touches storage or Discord', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');

    const [defer] = h.rest.calls;
    expect(defer?.path).toBe(`/interactions/${status.sessionId}/interaction-token/callback`);
    expect((defer?.body as { type?: number } | undefined)?.type).toBe(5);
  });

  test('starts the status, tags the nickname and books the 30-day expiry', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');

    expect(status).toMatchObject({
      userId: MEMBER,
      reason: 'lunch',
      previousNick: 'Bob',
      appliedNick: '[AFK] Bob',
      endedAt: null,
    });

    expect(h.nicknames()).toEqual([{ userId: MEMBER, nick: '[AFK] Bob' }]);

    expect(h.scheduler.booked).toEqual([
      {
        jobId: AFK_EXPIRE_JOB,
        runAt: new Date(status.since.getTime() + AFK_RETENTION_MS),
        naturalKey: `${MEMBER}:${status.sessionId}`,
        data: { userId: MEMBER, sessionId: status.sessionId },
        options: { replace: true },
      },
    ]);

    expect(h.lastFollowUp()).toBe(
      "You're AFK: lunch. I'll tell people who ping you, and clear it when you next send a " +
        'message in this server.',
    );
    expect(h.followUps()[0]?.allowed_mentions).toEqual({ parse: [] });
  });

  test('with no reason and no nickname, tags the display name and remembers there was no nickname', async () => {
    const h = harness();
    const status = await goAfk(h, undefined, { actorNick: null, actorDisplayName: 'bobby' });

    expect(status.reason).toBeNull();
    expect(status.previousNick).toBeNull();
    expect(h.nicknames()).toEqual([{ userId: MEMBER, nick: '[AFK] bobby' }]);
    expect(h.lastFollowUp()?.startsWith("You're AFK. I'll tell people")).toBe(true);
  });

  test('does not tag a name that already carries [AFK]', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch', { actorNick: '[AFK] Bob' });

    expect(h.nicknames()).toEqual([]);
    expect(status.appliedNick).toBeNull();
  });

  test('does not tag when the nickname is unknown, so coming back cannot wipe a real one', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch', { actorNick: undefined, actorDisplayName: 'bobby' });

    expect(h.nicknames()).toEqual([]);
    expect(status.appliedNick).toBeNull();
    expect(status.endedAt).toBeNull();
    expect(h.lastFollowUp()?.startsWith("You're AFK: lunch. I'll tell people")).toBe(true);
  });

  test('does not tag at all when the server turned the tag off', async () => {
    const h = harness();
    await goAfk(h, 'lunch', { config: { nicknameTag: false } });

    expect(h.nicknames()).toEqual([]);
  });

  for (const reason of ['see discord.gg/abc123', 'menu at https://example.org']) {
    test(`refuses "${reason}" before anything is stored`, async () => {
      const h = harness();
      await h.run('set', [stringOption('reason', reason)]);

      expect(h.store.statuses.size).toBe(0);
      expect(h.nicknames()).toEqual([]);
      expect(h.lastFollowUp()).toBe(REASON_HAS_LINK);
    });
  }

  test('refuses a reason over 100 characters', async () => {
    const h = harness();
    await h.run('set', [stringOption('reason', 'a'.repeat(101))]);

    expect(h.store.statuses.size).toBe(0);
    expect(h.lastFollowUp()).toBe(REASON_TOO_LONG);
  });

  test('running it again while away only changes the reason', async () => {
    const h = harness();
    const first = await goAfk(h, 'lunch');

    await h.run('set', [stringOption('reason', 'dinner')]);
    expect(h.lastFollowUp()).toBe('Updated your AFK reason: dinner');

    await h.run('set');
    expect(h.lastFollowUp()).toBe('Removed your AFK reason.');

    const now = await h.store.get(GUILD, MEMBER);
    expect(now?.sessionId).toBe(first.sessionId);
    expect(now?.reason).toBeNull();
    expect(h.nicknames()).toHaveLength(1);
  });

  test('a redelivered /afk set tags and answers once', async () => {
    const h = harness();
    const interactionId = snowflake('6');

    await h.run('set', [stringOption('reason', 'lunch')], { interactionId });
    await h.run('set', [stringOption('reason', 'lunch')], { interactionId });

    expect(h.store.statuses.size).toBe(1);
    expect(h.nicknames()).toHaveLength(1);
    expect(h.followUps()).toHaveLength(1);
    expect((await h.store.get(GUILD, MEMBER))?.appliedNick).toBe('[AFK] Bob');
  });

  test('a copy of /afk set that arrives after the member came back does nothing', async () => {
    const h = harness();
    const interactionId = snowflake('6');

    await h.run('set', [stringOption('reason', 'lunch')], { interactionId });
    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }));
    const calls = h.rest.calls.length;
    const booked = h.scheduler.booked.length;

    await h.run('set', [stringOption('reason', 'lunch')], { interactionId });

    expect(h.rest.calls).toHaveLength(calls);
    expect(h.scheduler.booked).toHaveLength(booked);
    await endedRecord(h);

    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));
    expect(h.rest.calls).toHaveLength(calls);
  });

  test('going AFK again after coming back starts a fresh session', async () => {
    const h = harness();
    const first = await goAfk(h, 'lunch');
    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }));

    const second = await goAfk(h, 'dinner');

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second).toMatchObject({
      reason: 'dinner',
      previousNick: 'Bob',
      appliedNick: '[AFK] Bob',
      endedAt: null,
    });
    expect(expiries(h).at(-1)?.data).toEqual({ userId: MEMBER, sessionId: second.sessionId });
    expect(h.lastFollowUp()).toStartWith("You're AFK: dinner.");
  });

  test('shows markdown in the reason as typed rather than applying it', async () => {
    const h = harness();
    await goAfk(h, 'back ||soon');
    expect(h.lastFollowUp()).toStartWith("You're AFK: back \\|\\|soon. I'll tell people");

    await h.run('set', [stringOption('reason', '**dinner**')]);
    expect(h.lastFollowUp()).toBe('Updated your AFK reason: \\*\\*dinner\\*\\*');
  });

  test('is refused while AFK is switched off in config', async () => {
    const h = harness();
    await h.run('set', [], { config: { enabled: false } });

    expect(h.store.statuses.size).toBe(0);
    expect(h.lastFollowUp()).toContain('switched off');
  });

  test('without a store it says it cannot run, and names the missing binding in the log', async () => {
    const h = harness({ deps: { applicationId: APPLICATION_ID } });
    await h.run('set', [stringOption('reason', 'lunch')]);

    expect(h.lastFollowUp()).toContain('fault on my side');
    expect(h.logs.find((log) => log.level === 'error')?.message).toContain(
      'store: new DrizzleAfkStore',
    );
  });

  test('without an application id it answers at once rather than deferring into silence', async () => {
    const h = harness({ deps: { store: new MemoryAfkStore() } });
    await h.run('set');

    const body = h.rest.calls[0]?.body as { type?: number; data?: { content?: string } };
    expect(h.rest.calls).toHaveLength(1);
    expect(body.type).toBe(4);
    expect(body.data?.content).toContain('fault on my side');
    expect(h.logs.find((log) => log.level === 'error')?.message).toContain(
      'env.DISCORD_APPLICATION_ID',
    );
  });
});

describe('/afk set when the tag cannot be applied', () => {
  test('the server owner is still AFK, and told Discord forbids renaming them', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch', { userId: OWNER });

    expect(status.appliedNick).toBeNull();
    expect(h.nicknames()).toEqual([]);
    expect(h.lastFollowUp()).toContain(
      "I couldn't add [AFK] to your nickname: Discord doesn't let bots change the server owner's nickname.",
    );
  });

  test('a member ranked above Proton is still AFK, and told how to fix it', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch', { userId: ABOVE_BOT });

    expect(status.appliedNick).toBeNull();
    expect(h.nicknames()).toEqual([]);
    expect(h.lastFollowUp()).toContain(
      "I couldn't add [AFK] to your nickname: your highest role is at or above mine. Move " +
        "Proton's role higher in Server Settings → Roles.",
    );
  });

  test('without Manage Nicknames the member is still AFK, and the permission is named', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS & ~Permissions.ManageNicknames });
    const status = await goAfk(h, 'lunch');

    expect(status.appliedNick).toBeNull();
    expect(h.nicknames()).toEqual([]);
    expect(h.lastFollowUp()).toContain(
      "I couldn't add [AFK] to your nickname: I'm missing the Manage Nicknames permission in this server.",
    );
  });
});

describe('coming back while the [AFK] tag is still on its way', () => {
  test('a return handled before the tag lands takes the tag back off, and /afk set says the AFK already ended', async () => {
    const h = harness();
    h.rest.intercept('PATCH', `/guilds/${GUILD}/members/${MEMBER}`, () =>
      h.emit(messageEvent({ authorId: MEMBER, nick: 'Bob' })),
    );

    await h.run('set', [stringOption('reason', 'lunch')]);

    expect(h.nicknames()).toEqual([
      { userId: MEMBER, nick: '[AFK] Bob' },
      { userId: MEMBER, nick: 'Bob' },
    ]);
    await endedRecord(h);

    expect(h.followUps()).toHaveLength(1);
    expect(h.lastFollowUp()).toBe(
      'Your AFK already ended: you sent a message while it was being set.',
    );
    expect(h.followUps()[0]?.allowed_mentions).toEqual({ parse: [] });
  });

  test('a message sent before the tag landed still restores the nickname', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.emit(messageEvent({ authorId: MEMBER, nick: 'Bob' }));

    expect(h.nicknames()).toEqual([
      { userId: MEMBER, nick: '[AFK] Bob' },
      { userId: MEMBER, nick: 'Bob' },
    ]);
  });
});

describe('pinging a member who is away', () => {
  test('replies once with the reason, records the ping and books the tidy-up', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');
    const before = Date.now();

    const ping = messageEvent({
      authorId: OTHER,
      mentions: [mention(MEMBER, { nick: '[AFK] Bob' })],
    });
    await h.emit(ping);

    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0]).toMatchObject({
      channelId: CHANNEL,
      body: {
        content: `**Bob** is AFK: lunch · ${sinceTag(status)}`,
        allowed_mentions: { parse: [] },
        message_reference: { message_id: messageIdOf(ping) },
        flags: 4,
      },
    });

    expect(await h.store.pings(status.sessionId)).toMatchObject([
      { authorId: OTHER, channelId: CHANNEL, messageId: messageIdOf(ping), userId: MEMBER },
    ]);

    const sentId = h.rest.sentIds[0];
    const tidy = h.scheduler.booked.find((job) => job.jobId === AFK_TIDY_JOB);
    expect(tidy?.naturalKey).toBe(`${CHANNEL}:${sentId}`);
    expect(tidy?.data).toEqual({ channelId: CHANNEL, messageId: sentId });
    expect(tidy?.runAt.getTime()).toBeGreaterThanOrEqual(before + 15_000);
    expect(tidy?.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 15_000);
  });

  test('books no tidy-up when the server keeps its replies', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }), { config: { tidyReplies: false } });

    expect(h.sends()).toHaveLength(1);
    expect(h.scheduler.booked.some((job) => job.jobId === AFK_TIDY_JOB)).toBe(false);
  });

  test('a second ping in the same minute is recorded but not answered; the next minute is', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');
    const bucket = nextBucket();

    await h.emit(messageEvent({ at: bucket + 1_000, mentions: [mention(MEMBER)] }));
    await h.emit(messageEvent({ at: bucket + 30_000, mentions: [mention(MEMBER)] }));

    expect(h.sends()).toHaveLength(1);
    expect(await h.store.pings(status.sessionId)).toHaveLength(2);

    await h.emit(
      messageEvent({ at: bucket + NOTICE_COOLDOWN_MS + 1_000, mentions: [mention(MEMBER)] }),
    );
    expect(h.sends()).toHaveLength(2);
  });

  test('in a channel without AFK replies, the ping still counts but nothing is said', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');

    await h.emit(messageEvent({ channelId: QUIET_CHANNEL, mentions: [mention(MEMBER)] }), {
      config: { ignoredChannelIds: [QUIET_CHANNEL] },
    });

    expect(h.sends()).toEqual([]);
    expect(await h.store.pings(status.sessionId)).toHaveLength(1);
  });

  test('in a thread inside a channel without AFK replies, the ping counts but nothing is said', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');

    await h.emit(messageEvent({ channelId: THREAD, mentions: [mention(MEMBER)] }), {
      config: { ignoredChannelIds: [QUIET_CHANNEL] },
    });

    expect(h.sends()).toEqual([]);
    expect(await h.store.pings(status.sessionId)).toHaveLength(1);
  });

  test('without guild state, only the listed channel itself is quiet', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.emit(messageEvent({ channelId: THREAD, mentions: [mention(MEMBER)] }), {
      config: { ignoredChannelIds: [QUIET_CHANNEL] },
      deps: { store: h.store, applicationId: APPLICATION_ID },
    });

    expect(h.sends()).toHaveLength(1);
  });

  test('a redelivered mention is answered and recorded once', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');
    const ping = messageEvent({ mentions: [mention(MEMBER)] });

    await h.emit(ping);
    await h.emit(ping);

    expect(h.sends()).toHaveLength(1);
    expect(await h.store.pings(status.sessionId)).toHaveLength(1);
  });

  test('a ping sent before the member went AFK does not count', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');

    await h.emit(messageEvent({ at: status.since.getTime() - 1_000, mentions: [mention(MEMBER)] }));

    expect(h.sends()).toEqual([]);
    expect(await h.store.pings(status.sessionId)).toEqual([]);
  });

  test('bots and webhooks pinging an away member are ignored', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');

    await h.emit(messageEvent({ bot: true, mentions: [mention(MEMBER)] }));
    await h.emit(messageEvent({ webhook: true, mentions: [mention(MEMBER)] }));

    expect(h.sends()).toEqual([]);
    expect(await h.store.pings(status.sessionId)).toEqual([]);
  });

  test('without Send Messages the notice is refused, the log names it and the channel, and the ping still counts', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');
    h.botPermissions = BOT_PERMISSIONS & ~Permissions.SendMessages;

    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));

    expect(h.sends()).toEqual([]);
    expect(
      warnings(h).some((line) => line.includes('Send Messages') && line.includes(`<#${CHANNEL}>`)),
    ).toBe(true);
    expect(await h.store.pings(status.sessionId)).toHaveLength(1);
  });

  test('without Read Message History the reply is refused and the log names it', async () => {
    const h = harness();
    await goAfk(h, 'lunch');
    h.botPermissions = BOT_PERMISSIONS & ~Permissions.ReadMessageHistory;

    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));

    expect(h.sends()).toEqual([]);
    expect(warnings(h).some((line) => line.includes('Read Message History'))).toBe(true);
  });
});

describe('coming back', () => {
  test('clears the status, restores the nickname, DMs the recap and welcomes them back', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');

    const ping = messageEvent({
      authorId: OTHER,
      mentions: [mention(MEMBER, { nick: '[AFK] Bob' })],
    });
    await h.emit(ping);
    const before = Date.now();
    const back = messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' });
    await h.emit(back);

    expect(await endedRecord(h)).toMatchObject({
      sessionId: status.sessionId,
      endedBy: `message:${messageIdOf(back)}`,
    });
    expect(await h.store.pings(status.sessionId)).toEqual([]);
    expect(h.nicknames()).toEqual([
      { userId: MEMBER, nick: '[AFK] Bob' },
      { userId: MEMBER, nick: 'Bob' },
    ]);

    expect(h.dmOpens()).toBe(1);
    const dm = h.sends().find((sent) => sent.channelId === DM_CHANNEL);
    expect(dm?.body.content).toContain('You were pinged 1 time while you were AFK:');
    expect(dm?.body.content).toContain(`<@${OTHER}> in <#${CHANNEL}>`);
    expect(dm?.body.content).toContain(
      `https://discord.com/channels/${GUILD}/${CHANNEL}/${messageIdOf(ping)}`,
    );
    expect(dm?.body.allowed_mentions).toEqual({ parse: [] });
    expect(dm?.body.flags).toBe(4);

    const welcome = h.sends().at(-1);
    expect(welcome?.channelId).toBe(CHANNEL);
    expect(welcome?.body.content).toBe(
      "Welcome back, **Bob**. You were AFK for less than a minute. I've sent you the 1 ping you missed.",
    );
    expect(welcome?.body.allowed_mentions).toEqual({ parse: [] });
    expect(welcome?.body.flags).toBe(4);

    const purge = expiries(h).at(-1);
    expect(purge).toMatchObject({
      naturalKey: `${MEMBER}:${status.sessionId}`,
      data: { userId: MEMBER, sessionId: status.sessionId },
      options: { replace: true },
    });
    expect(purge?.runAt.getTime()).toBeGreaterThanOrEqual(before + AFK_TOMBSTONE_MS);
    expect(purge?.runAt.getTime()).toBeLessThanOrEqual(Date.now() + AFK_TOMBSTONE_MS);
    expect(h.scheduler.cancelled).toEqual([]);
  });

  test('leaves a nickname the member changed while away', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.emit(messageEvent({ authorId: MEMBER, nick: 'Robert' }));

    expect(h.nicknames()).toHaveLength(1);
    expect(h.sends().at(-1)?.body.content).toStartWith('Welcome back, **Robert**.');
  });

  test('restores the nickname when the message does not say what it is now', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.emit(messageEvent({ authorId: MEMBER, member: false, username: 'bob' }));

    expect(h.nicknames().at(-1)).toEqual({ userId: MEMBER, nick: 'Bob' });
  });

  test('says the list could not be sent when the member’s DMs are closed', async () => {
    const h = harness();
    await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));
    h.rest.fail('POST', '/users/@me/channels', 403);

    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }));

    expect(h.sends().at(-1)?.body.content).toBe(
      'Welcome back, **Bob**. You were AFK for less than a minute. 1 ping came in while you were ' +
        "away, but I couldn't DM you the list.",
    );
    expect(warnings(h).some((line) => line.includes('could not open a DM'))).toBe(true);
  });

  test('says the list could not be sent when the DM itself is refused', async () => {
    const h = harness();
    await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));
    h.rest.fail('POST', `/channels/${DM_CHANNEL}/messages`, 403);

    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }));

    expect(h.sends().at(-1)?.body.content).toContain("couldn't DM you the list");
  });

  test('with no pings there is no DM and no recap line', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }));

    expect(h.dmOpens()).toBe(0);
    expect(h.sends().at(-1)?.body.content).toBe(
      'Welcome back, **Bob**. You were AFK for less than a minute.',
    );
  });

  test('with the recap turned off there is no DM', async () => {
    const h = harness();
    await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));

    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }), {
      config: { recap: false },
    });

    expect(h.dmOpens()).toBe(0);
    expect(h.sends().at(-1)?.body.content).toBe(
      'Welcome back, **Bob**. You were AFK for less than a minute.',
    );
  });

  test('a redelivered return restores, DMs and welcomes once', async () => {
    const h = harness();
    await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));

    const back = messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' });
    await h.emit(back);
    await h.emit(back);

    expect(h.nicknames()).toHaveLength(2);
    expect(h.dmOpens()).toBe(1);
    expect(h.sends().filter((sent) => sent.body.content?.startsWith('Welcome back'))).toHaveLength(
      1,
    );
  });

  test('in a channel without AFK replies the status clears quietly', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.emit(messageEvent({ authorId: MEMBER, channelId: QUIET_CHANNEL, nick: '[AFK] Bob' }), {
      config: { ignoredChannelIds: [QUIET_CHANNEL] },
    });

    await endedRecord(h);
    expect(h.nicknames().at(-1)).toEqual({ userId: MEMBER, nick: 'Bob' });
    expect(h.sends()).toEqual([]);
  });

  test('in a thread inside a channel without AFK replies the status clears quietly too', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.emit(messageEvent({ authorId: MEMBER, channelId: THREAD, nick: '[AFK] Bob' }), {
      config: { ignoredChannelIds: [QUIET_CHANNEL] },
    });

    await endedRecord(h);
    expect(h.nicknames().at(-1)).toEqual({ userId: MEMBER, nick: 'Bob' });
    expect(h.sends()).toEqual([]);
  });

  test('says so when Proton can no longer take [AFK] off the nickname', async () => {
    const h = harness();
    await goAfk(h, 'lunch');
    h.botPermissions = BOT_PERMISSIONS & ~Permissions.ManageNicknames;

    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }));

    expect(h.nicknames()).toHaveLength(1);
    expect(h.sends().at(-1)?.body.content).toBe(
      "Welcome back, **Bob**. You were AFK for less than a minute. I couldn't take [AFK] off " +
        "your nickname: I'm missing the Manage Nicknames permission in this server.",
    );
  });

  test('when the server’s channels cannot be read, it decides before ending the session and still welcomes them back', async () => {
    const h = harness();
    await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));

    const seen: Array<AfkStatus | null> = [];
    const back = h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }), {
      config: { ignoredChannelIds: [QUIET_CHANNEL] },
      deps: {
        store: h.store,
        applicationId: APPLICATION_ID,
        guildState: {
          get: async () => {
            seen.push(await h.store.get(GUILD, MEMBER));
            throw new Error('guild state is unreachable');
          },
        },
      },
    });

    await expect(back).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.endedAt).toBeNull();
    expect(h.sends().at(-1)?.body.content).toBe(
      "Welcome back, **Bob**. You were AFK for less than a minute. I've sent you the 1 ping you missed.",
    );
    expect(
      warnings(h).some(
        (line) => line.includes(GUILD) && line.includes('guild state is unreachable'),
      ),
    ).toBe(true);
  });

  test('a message from before the member went AFK does not end it', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');

    await h.emit(messageEvent({ authorId: MEMBER, at: status.since.getTime() - 1 }));

    expect(await h.store.get(GUILD, MEMBER)).not.toBeNull();
  });
});

describe('with AFK switched off in config', () => {
  test('messages do nothing at all', async () => {
    const h = harness();
    await goAfk(h, 'lunch');
    const calls = h.rest.calls.length;

    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }), {
      config: { enabled: false },
    });
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }), { config: { enabled: false } });

    expect(h.rest.calls).toHaveLength(calls);
    expect(await h.store.get(GUILD, MEMBER)).not.toBeNull();
  });
});

describe('/afk clear', () => {
  test('clears your own AFK, restores the nickname and sends the recap', async () => {
    const h = harness();
    await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));

    await h.run('clear', [], { actorNick: '[AFK] Bob' });

    expect(h.lastFollowUp()).toBe("Your AFK is cleared. I've sent you the 1 ping you missed.");
    expect(h.nicknames().at(-1)).toEqual({ userId: MEMBER, nick: 'Bob' });
    expect(h.dmOpens()).toBe(1);
    expect((await endedRecord(h)).endedBy).toStartWith('command:');
  });

  test('says so when you are not AFK', async () => {
    const h = harness();
    await h.run('clear');

    expect(h.lastFollowUp()).toBe("You aren't AFK.");
  });

  test("clearing someone else's needs Manage Nicknames", async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.run('clear', [userOption('member', MEMBER)], {
      userId: STAFF,
      actorPermissions: Permissions.SendMessages,
    });
    await h.run('clear', [userOption('member', MEMBER)], { userId: STAFF });

    expect(
      h
        .followUps()
        .slice(-2)
        .map((body) => body.content),
    ).toEqual([
      "You need the Manage Nicknames permission to clear someone else's AFK.",
      "You need the Manage Nicknames permission to clear someone else's AFK.",
    ]);
    expect(await h.store.get(GUILD, MEMBER)).not.toBeNull();
  });

  test('staff with Manage Nicknames clear it and restore the nickname, with no DM', async () => {
    const h = harness();
    await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));

    await h.run('clear', [userOption('member', MEMBER)], {
      userId: STAFF,
      actorPermissions: Permissions.ManageNicknames,
    });

    expect(h.lastFollowUp()).toBe(`Cleared <@${MEMBER}>'s AFK.`);
    expect(h.followUps().at(-1)?.allowed_mentions).toEqual({ parse: [] });
    expect(h.nicknames().at(-1)).toEqual({ userId: MEMBER, nick: 'Bob' });
    expect(h.dmOpens()).toBe(0);
    expect((await endedRecord(h)).endedBy).toStartWith('command:');
  });

  test('Administrator is enough to clear someone else', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.run('clear', [userOption('member', MEMBER)], {
      userId: STAFF,
      actorPermissions: Permissions.Administrator,
    });

    expect(h.lastFollowUp()).toBe(`Cleared <@${MEMBER}>'s AFK.`);
  });

  test('says when the member named is not AFK', async () => {
    const h = harness();

    await h.run('clear', [userOption('member', OTHER)], {
      userId: STAFF,
      actorPermissions: Permissions.ManageNicknames,
    });

    expect(h.lastFollowUp()).toBe(`<@${OTHER}> isn't AFK.`);
  });
});

describe('config changes', () => {
  test('switching the module off ends every status and restores nicknames, without DMs', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));

    await h.emit(configChanged({ enabledBefore: true, enabledAfter: false }));

    expect(await h.store.all(GUILD)).toEqual([]);
    expect(await h.store.pings(status.sessionId)).toEqual([]);
    expect(h.nicknames().at(-1)).toEqual({ userId: MEMBER, nick: 'Bob' });
    expect(h.dmOpens()).toBe(0);
    expect(h.scheduler.cancelled).toEqual([
      { jobId: AFK_EXPIRE_JOB, naturalKey: `${MEMBER}:${status.sessionId}` },
    ]);
    expect(h.scheduler.pending(AFK_EXPIRE_JOB)).toEqual([]);
  });

  test('setting enabled to false in config tears down the same way', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.emit(configChanged({ changedKeys: ['enabled'] }), { config: { enabled: false } });

    expect(await h.store.all(GUILD)).toEqual([]);
    expect(h.nicknames().at(-1)).toEqual({ userId: MEMBER, nick: 'Bob' });
  });

  test('switching the module off also deletes the records of sessions that already ended', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');
    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }));

    await h.emit(configChanged({ enabledBefore: true, enabledAfter: false }));

    expect(await h.store.all(GUILD)).toEqual([]);
    expect(h.nicknames()).toHaveLength(2);
    expect(h.scheduler.cancelled).toEqual([
      { jobId: AFK_EXPIRE_JOB, naturalKey: `${MEMBER}:${status.sessionId}` },
    ]);
    expect(h.scheduler.pending(AFK_EXPIRE_JOB)).toEqual([]);
  });

  test('a change to another module is ignored', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.emit(configChanged({ moduleId: 'reminders', enabledAfter: false }));

    expect(await h.store.get(GUILD, MEMBER)).not.toBeNull();
    expect(h.nicknames()).toHaveLength(1);
  });

  test('turning the tag off restores tagged nicknames once and keeps everyone AFK', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    const change = configChanged({ changedKeys: ['nicknameTag'] });
    await h.emit(change, { config: { nicknameTag: false } });
    await h.emit(change, { config: { nicknameTag: false } });

    expect(h.nicknames()).toEqual([
      { userId: MEMBER, nick: '[AFK] Bob' },
      { userId: MEMBER, nick: 'Bob' },
    ]);

    const kept = await h.store.get(GUILD, MEMBER);
    expect(kept?.endedAt).toBeNull();
    expect(kept?.appliedNick).toBeNull();

    await h.emit(messageEvent({ authorId: MEMBER, nick: 'Bob' }), {
      config: { nicknameTag: false },
    });
    expect(h.nicknames()).toHaveLength(2);
  });
});

describe('a member leaving', () => {
  test('forgets their status and pings without calling Discord', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));
    const calls = h.rest.calls.length;

    await h.emit(memberLeft(MEMBER));

    expect(await h.store.get(GUILD, MEMBER)).toBeNull();
    expect(await h.store.pings(status.sessionId)).toEqual([]);
    expect(h.rest.calls).toHaveLength(calls);
    expect(h.scheduler.cancelled).toEqual([
      { jobId: AFK_EXPIRE_JOB, naturalKey: `${MEMBER}:${status.sessionId}` },
    ]);
    expect(h.scheduler.pending(AFK_EXPIRE_JOB)).toEqual([]);
  });
});

describe('the expiry job', () => {
  test('ends the session it was booked for and restores the nickname, without a DM', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));

    await h.job(AFK_EXPIRE_JOB, { userId: MEMBER, sessionId: status.sessionId });

    expect(await h.store.get(GUILD, MEMBER)).toBeNull();
    expect(await h.store.pings(status.sessionId)).toEqual([]);
    expect(h.nicknames().at(-1)).toEqual({ userId: MEMBER, nick: 'Bob' });
    expect(h.dmOpens()).toBe(0);
    expect(h.scheduler.cancelled).toEqual([]);
  });

  test('a day after a return, deletes the ended record without calling Discord', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');
    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }));
    const calls = h.rest.calls.length;

    await h.job(AFK_EXPIRE_JOB, { userId: MEMBER, sessionId: status.sessionId });

    expect(await h.store.get(GUILD, MEMBER)).toBeNull();
    expect(h.rest.calls).toHaveLength(calls);
    expect(h.scheduler.cancelled).toEqual([]);
  });

  test('a session whose ending was cut short still has its tag taken off and is deleted', async () => {
    const h = harness();
    const status = await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));
    await h.store.markEnded(status.sessionId, 'message:1');

    await h.job(AFK_EXPIRE_JOB, { userId: MEMBER, sessionId: status.sessionId });

    expect(await h.store.get(GUILD, MEMBER)).toBeNull();
    expect(await h.store.pings(status.sessionId)).toEqual([]);
    expect(h.nicknames().at(-1)).toEqual({ userId: MEMBER, nick: 'Bob' });
    expect(h.scheduler.cancelled).toEqual([]);
  });

  test("an old session's purge and a new session's expiry are booked apart, and the purge leaves the new session alone", async () => {
    const h = harness();
    const first = await goAfk(h, 'lunch');
    await h.emit(messageEvent({ mentions: [mention(MEMBER)] }));

    const started: AfkStatus[] = [];
    h.rest.intercept('POST', '/users/@me/channels', async () => {
      started.push(await goAfk(h, 'dinner'));
    });

    const before = Date.now();
    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }));

    const second = started[0];
    if (!second) throw new Error('the second /afk set did not run while the first one was ending');

    const booked = h.scheduler.pending(AFK_EXPIRE_JOB);
    expect(booked).toHaveLength(2);
    expect(booked).toContainEqual({
      jobId: AFK_EXPIRE_JOB,
      runAt: new Date(second.since.getTime() + AFK_RETENTION_MS),
      naturalKey: `${MEMBER}:${second.sessionId}`,
      data: { userId: MEMBER, sessionId: second.sessionId },
      options: { replace: true },
    });

    const purge = booked.find((job) => job.naturalKey === `${MEMBER}:${first.sessionId}`);
    expect(purge?.data).toEqual({ userId: MEMBER, sessionId: first.sessionId });
    expect(purge?.runAt.getTime()).toBeGreaterThanOrEqual(before + AFK_TOMBSTONE_MS);

    const calls = h.rest.calls.length;
    await h.job(AFK_EXPIRE_JOB, { userId: MEMBER, sessionId: first.sessionId });

    expect(await h.store.get(GUILD, MEMBER)).toMatchObject({
      sessionId: second.sessionId,
      reason: 'dinner',
      appliedNick: '[AFK] Bob',
      endedAt: null,
    });
    expect(h.rest.calls).toHaveLength(calls);
    expect(h.scheduler.cancelled).toEqual([]);
    expect(h.scheduler.pending(AFK_EXPIRE_JOB)).toEqual(booked);
  });

  test('leaves a newer session alone', async () => {
    const h = harness();
    await goAfk(h, 'lunch');

    await h.job(AFK_EXPIRE_JOB, { userId: MEMBER, sessionId: '600000000000009999' });

    expect(await h.store.get(GUILD, MEMBER)).not.toBeNull();
  });
});

describe('the tidy job', () => {
  test('deletes the reply', async () => {
    const h = harness();
    const messageId = snowflake('7');

    await h.job(AFK_TIDY_JOB, { channelId: CHANNEL, messageId });

    expect(h.deletes()).toEqual([`/channels/${CHANNEL}/messages/${messageId}`]);
  });

  test('a reply that is already gone counts as tidied', async () => {
    const h = harness();
    h.rest.fail('DELETE', '/channels/', 404);

    await h.job(AFK_TIDY_JOB, { channelId: CHANNEL, messageId: snowflake('7') });

    expect(warnings(h)).toEqual([]);
  });

  test('without Manage Messages it logs the permission and leaves the reply, without retrying', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS & ~Permissions.ManageMessages });

    await h.job(AFK_TIDY_JOB, { channelId: CHANNEL, messageId: snowflake('7') });

    expect(h.deletes()).toEqual([]);
    expect(warnings(h).some((line) => line.includes('Manage Messages'))).toBe(true);
  });

  test('any other failure throws so the sweeper retries', async () => {
    const h = harness();
    h.rest.fail('DELETE', '/channels/', 500);

    await expect(
      h.job(AFK_TIDY_JOB, { channelId: CHANNEL, messageId: snowflake('7') }),
    ).rejects.toThrow('could not delete');
  });
});
