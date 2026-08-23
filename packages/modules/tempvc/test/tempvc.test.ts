import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import {
  BOT_PERMISSIONS,
  CATEGORY,
  CREATED,
  GUILD,
  guildAvailableEvent,
  type Harness,
  HUB,
  harness,
  integerOption,
  MEMBER,
  OTHER,
  stringOption,
  subcommand,
  TEMP,
  voiceEvent,
} from './harness.ts';

function writtenOverwrites(h: Harness): Array<{ id: string; deny: string }> {
  const body = h.discordCalls()[0]?.body as
    | { permission_overwrites?: Array<{ id: string; deny: string }> }
    | undefined;

  return body?.permission_overwrites ?? [];
}

describe('joining a hub', () => {
  test('creates a voice channel in the hub category and moves the member into it', async () => {
    const h = harness();

    await h.emit(voiceEvent(MEMBER, HUB));

    const [create, move] = h.discordCalls();

    expect(create?.method).toBe('POST');
    expect(create?.path).toBe(`/guilds/${GUILD}/channels`);
    expect(create?.body).toMatchObject({ type: 2, parent_id: CATEGORY, name: 'Member’s room' });

    expect(move?.method).toBe('PATCH');
    expect(move?.path).toBe(`/guilds/${GUILD}/members/${MEMBER}`);
    expect(move?.body).toEqual({ channel_id: CREATED });
  });

  test('records the created channel so it can be cleaned up later', async () => {
    const h = harness();

    await h.emit(voiceEvent(MEMBER, HUB));

    expect(await h.store.get(GUILD, CREATED)).toMatchObject({
      ownerId: MEMBER,
      hubChannelId: HUB,
    });
  });

  test('uses the nickname when the member has one', async () => {
    const h = harness();

    await h.emit(voiceEvent(MEMBER, HUB, { nick: 'Ada' }));

    expect(h.discordCalls()[0]?.body).toMatchObject({ name: 'Ada’s room' });
  });

  test('carries the hub user limit onto the new channel', async () => {
    const h = harness();

    await h.emit(voiceEvent(MEMBER, HUB), {
      config: { hubs: [{ channelId: HUB, nameTemplate: '{user}', userLimit: 4 }] },
    });

    expect(h.discordCalls()[0]?.body).toMatchObject({ user_limit: 4 });
  });

  test('a member who already owns a channel is moved to it instead of getting a second', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    await h.emit(voiceEvent(MEMBER, HUB));

    expect(h.discordCalls()).toHaveLength(1);
    expect(h.discordCalls()[0]?.method).toBe('PATCH');
    expect(h.discordCalls()[0]?.body).toEqual({ channel_id: TEMP });
  });

  test('a redelivered join creates nothing the second time', async () => {
    const h = harness();
    const event = voiceEvent(MEMBER, HUB, { id: 'fixed-event-id' });

    await h.emit(event);
    await h.emit(event);

    expect(h.discordCalls().filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  test('a redelivered join does not delete the channel the member was moved into', async () => {
    const h = harness();
    const join = voiceEvent(MEMBER, HUB, { id: 'voice.state_updated:join' });

    await h.emit(join);
    await h.emit(voiceEvent(MEMBER, CREATED));
    await h.emit(join);

    expect(h.discordCalls().some((call) => call.method === 'DELETE')).toBe(false);
    expect(await h.store.get(GUILD, CREATED)).not.toBeNull();
    expect(await h.store.locate(GUILD, MEMBER)).toBe(CREATED);
    expect(await h.store.occupants(GUILD, CREATED)).toBe(1);
  });

  test('a member sitting in somebody else’s channel still gets their own from the hub', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: OTHER, hubChannelId: HUB });
    await h.emit(voiceEvent(MEMBER, TEMP));

    await h.emit(voiceEvent(MEMBER, HUB));

    expect(h.discordCalls().some((call) => call.method === 'POST')).toBe(true);
  });

  test('bots are ignored, so a music bot in a hub makes no channels', async () => {
    const h = harness();

    await h.emit(voiceEvent(MEMBER, HUB, { isBot: true }));

    expect(h.discordCalls()).toHaveLength(0);
  });

  test('joining an ordinary voice channel does nothing', async () => {
    const h = harness();

    await h.emit(voiceEvent(MEMBER, TEMP));

    expect(h.discordCalls()).toHaveLength(0);
  });

  test('names ManageChannels when the bot cannot create the channel', async () => {
    const h = harness();

    await h.emit(voiceEvent(MEMBER, HUB), {
      botPermissions: BOT_PERMISSIONS & ~Permissions.ManageChannels,
    });

    expect(h.discordCalls()).toHaveLength(0);
    expect(
      h.logs.some((line) => line.level === 'error' && line.message.includes('ManageChannels')),
    ).toBe(true);
  });

  test('says so when the channel was made but the member could not be moved', async () => {
    const h = harness();

    await h.emit(voiceEvent(MEMBER, HUB), {
      botPermissions: BOT_PERMISSIONS & ~Permissions.MoveMembers,
    });

    expect(h.discordCalls().filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(
      h.logs.some((line) => line.level === 'error' && line.message.includes('MoveMembers')),
    ).toBe(true);
  });
});

describe('leaving a temporary channel', () => {
  test('deletes it once the last member leaves', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });
    await h.emit(voiceEvent(MEMBER, TEMP));

    await h.emit(voiceEvent(MEMBER, null));

    const remove = h.discordCalls().find((call) => call.method === 'DELETE');
    expect(remove?.path).toBe(`/channels/${TEMP}`);
    expect(await h.store.get(GUILD, TEMP)).toBeNull();
  });

  test('leaves it alone while somebody else is still in it', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });
    await h.emit(voiceEvent(MEMBER, TEMP));
    await h.emit(voiceEvent(OTHER, TEMP));

    await h.emit(voiceEvent(MEMBER, null));

    expect(h.discordCalls().some((call) => call.method === 'DELETE')).toBe(false);
    expect(await h.store.get(GUILD, TEMP)).not.toBeNull();
  });

  test('deletes it when the last of two members leaves', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });
    await h.emit(voiceEvent(MEMBER, TEMP));
    await h.emit(voiceEvent(OTHER, TEMP));

    await h.emit(voiceEvent(MEMBER, null));
    await h.emit(voiceEvent(OTHER, null));

    expect(h.discordCalls().filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  test('a mute or deafen update does not count as leaving', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });
    await h.emit(voiceEvent(MEMBER, TEMP));

    await h.emit(voiceEvent(MEMBER, TEMP));

    expect(h.discordCalls()).toHaveLength(0);
  });
});

describe('reconnecting', () => {
  test('deletes temporary channels that emptied while the worker was down', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    await h.emit(guildAvailableEvent([]));

    expect(h.discordCalls().find((call) => call.method === 'DELETE')?.path).toBe(
      `/channels/${TEMP}`,
    );
  });

  test('keeps one that is still occupied, and can then empty it normally', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    await h.emit(guildAvailableEvent([{ channelId: TEMP, userId: OTHER }]));
    expect(h.discordCalls()).toHaveLength(0);

    await h.emit(voiceEvent(OTHER, null));

    expect(h.discordCalls().find((call) => call.method === 'DELETE')?.path).toBe(
      `/channels/${TEMP}`,
    );
  });

  test('forgets a channel Discord no longer lists rather than deleting it again', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    await h.emit(guildAvailableEvent([], [HUB]));

    expect(h.discordCalls()).toHaveLength(0);
    expect(await h.store.get(GUILD, TEMP)).toBeNull();
  });

  test('does nothing at all when this guild has no temporary channels', async () => {
    const h = harness();

    await h.emit(guildAvailableEvent([]));

    expect(h.discordCalls()).toHaveLength(0);
  });
});

describe('/vc', () => {
  test('renames the caller’s own channel', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    await h.run(subcommand('name', [stringOption('name', 'Study room')]));

    const edit = h.discordCalls()[0];
    expect(edit?.method).toBe('PATCH');
    expect(edit?.path).toBe(`/channels/${TEMP}`);
    expect(edit?.body).toEqual({ name: 'Study room' });
  });

  test('sets a member limit', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    await h.run(subcommand('limit', [integerOption('limit', 5)]));

    expect(h.discordCalls()[0]?.body).toEqual({ user_limit: 5 });
  });

  test('locking denies Connect to @everyone, whose role id is the guild id', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    await h.run(subcommand('lock'));

    expect(h.discordCalls()[0]?.body).toEqual({
      permission_overwrites: [
        { id: GUILD, type: 0, allow: '0', deny: Permissions.Connect.toString() },
      ],
    });
  });

  test('locking keeps every other overwrite the channel already has', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    h.overwrites.set(TEMP, [
      { id: MEMBER, type: 1, allow: Permissions.Connect, deny: 0n },
      { id: GUILD, type: 0, allow: 0n, deny: 0n },
    ]);

    await h.run(subcommand('lock'));

    const written = writtenOverwrites(h);

    expect(written.some((entry) => entry.id === MEMBER)).toBe(true);
    expect(written.find((entry) => entry.id === GUILD)?.deny).toBe(Permissions.Connect.toString());
  });

  test('unlocking lifts only the Connect deny it added', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    h.overwrites.set(TEMP, [
      { id: MEMBER, type: 1, allow: Permissions.Connect, deny: 0n },
      { id: GUILD, type: 0, allow: 0n, deny: Permissions.Connect | Permissions.SendMessages },
    ]);

    await h.run(subcommand('unlock'));

    const written = writtenOverwrites(h);

    expect(written.some((entry) => entry.id === MEMBER)).toBe(true);
    expect(written.find((entry) => entry.id === GUILD)?.deny).toBe(
      Permissions.SendMessages.toString(),
    );
  });

  test('unlocking clears the overwrites again', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    await h.run(subcommand('unlock'));

    expect(h.discordCalls()[0]?.body).toEqual({ permission_overwrites: [] });
  });

  test('refuses somebody else’s channel and says where to run it', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: OTHER, hubChannelId: HUB });

    await h.run(subcommand('name', [stringOption('name', 'Mine now')]));

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('your own temporary voice channel');
  });

  test('refuses an ordinary channel', async () => {
    const h = harness();

    await h.run(subcommand('name', [stringOption('name', 'Nope')]), { channelId: HUB });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('your own temporary voice channel');
  });

  test('says so when the server has turned member control off', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    await h.run(subcommand('lock'), { config: { ownerCommands: false } });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('turned off member control');
  });

  test('names the missing permission when the bot cannot edit the channel', async () => {
    const h = harness();
    await h.store.claim({ guildId: GUILD, channelId: TEMP, ownerId: MEMBER, hubChannelId: HUB });

    await h.run(subcommand('name', [stringOption('name', 'Study room')]), {
      botPermissions: BOT_PERMISSIONS & ~Permissions.ManageChannels,
    });

    expect(h.discordCalls()).toHaveLength(0);
    expect(h.replyContent()).toContain('ManageChannels');
  });

  test('names the missing wiring when the store was never bound', async () => {
    const h = harness();

    await h.run(subcommand('lock'), { deps: {} });

    expect(h.replyContent()).toContain("isn't fully wired up");
  });
});
