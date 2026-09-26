import { describe, expect, test } from 'bun:test';
import {
  formatCommandLabel,
  type ProtonEvent,
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import { voiceCommand } from '../src/commands.ts';
import { OWNER_CONTROLS } from '../src/config.ts';
import { panelMessage } from '../src/interface.ts';
import { handleVoiceState, presenceOf } from '../src/voice.ts';
import {
  ADA,
  APPLICATION,
  BEN,
  type CommandCall,
  CREATED,
  callsOf,
  commandContext,
  depsOf,
  type Fake,
  GUILD,
  type HarnessOptions,
  harness,
  initialCallbacks,
  member,
  replyColour,
  replyText,
  stringOption,
  userOption,
} from './harness.ts';

async function withChannel(options: HarnessOptions = {}) {
  const fake = harness(options);
  const outcome = await fake.service.create(fake.ctx, fake.hub, member());
  if (!('created' in outcome)) throw new Error('expected a channel');

  fake.calls.length = 0;

  return { fake, row: outcome.created, deps: depsOf(fake) };
}

async function run(fake: Fake, deps: ReturnType<typeof depsOf>, call: CommandCall): Promise<void> {
  await voiceCommand(deps).handler(commandContext(fake, call));
}

const MUSIC_BOT = '800000000000000009';

async function botJoins(fake: Fake, channelId: string): Promise<void> {
  const event: ProtonEvent = {
    id: `voice-${MUSIC_BOT}-${channelId}`,
    type: 'voice.state_updated',
    guildId: GUILD,
    occurredAt: 1,
    payload: {
      user_id: MUSIC_BOT,
      channel_id: channelId,
      member: { user: { id: MUSIC_BOT, username: 'music', bot: true } },
    },
  };

  await handleVoiceState(
    event,
    fake.ctx,
    fake.service,
    fake.repository,
    presenceOf(fake.presence),
    depsOf(fake),
  );
  fake.calls.length = 0;
}

describe('/voice answers with a status embed', () => {
  test('a rename that lands is green and names the new name', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'rename', options: [stringOption('name', 'Study room')] });

    expect(callsOf(fake, 'edit_channel')[0]?.payload.name).toBe('Study room');
    expect(replyText(fake)).toBe(`${STATUS_SUCCESS_EMOJI} Renamed your channel to **Study room**.`);
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
  });

  test('a rename Discord refuses is red and keeps the reason out of the reply', async () => {
    const { fake, deps } = await withChannel();
    fake.refuse('edit_channel', 'missing_permission', 'Manage Channels is missing');

    await run(fake, deps, { sub: 'rename', options: [stringOption('name', 'Study room')] });

    expect(replyText(fake)).toContain('Couldn’t rename your channel');
    expect(replyText(fake)).not.toContain('Manage Channels is missing');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('an empty name is refused before Discord is called', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'rename', options: [stringOption('name', '   ')] });

    expect(callsOf(fake, 'edit_channel')).toHaveLength(0);
    expect(replyText(fake)).toBe(`${STATUS_ERROR_EMOJI} The name can’t be empty.`);
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a member who does not own the channel is refused', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, {
      sub: 'rename',
      userId: BEN,
      options: [stringOption('name', 'Mine now')],
    });

    expect(callsOf(fake, 'edit_channel')).toHaveLength(0);
    expect(replyText(fake)).toContain('This isn’t your channel');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('running it outside a temporary channel is refused', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, {
      sub: 'rename',
      channelId: '600000000000000099',
      options: [stringOption('name', 'Study room')],
    });

    expect(replyText(fake)).toContain('Run this in the chat of a temporary voice channel');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a server with member control disabled is refused', async () => {
    const { fake, deps } = await withChannel();
    fake.ctx.config.ownerCommands = false;

    await run(fake, deps, { sub: 'rename', options: [stringOption('name', 'Study room')] });

    expect(replyText(fake)).toContain('doesn’t let owners manage their temporary channels');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a control the admin disabled names the control', async () => {
    const { fake, deps } = await withChannel();
    fake.ctx.config.hubs[0] = { ...fake.hub, allow: { ...fake.hub.allow, kick: false } };

    await run(fake, deps, { sub: 'kick', options: [userOption('member', BEN)] });

    expect(callsOf(fake, 'move_member')).toHaveLength(0);
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} This server has turned off **Kick** for temporary channels.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a kick that lands names the member', async () => {
    const { fake, deps } = await withChannel();
    fake.voice.set(BEN, CREATED);

    await run(fake, deps, { sub: 'kick', options: [userOption('member', BEN)] });

    expect(callsOf(fake, 'move_member')[0]?.payload.channelId).toBeNull();
    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Disconnected <@${BEN}> from your channel.`,
    );
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
  });

  test('a kick aimed at somebody in another voice channel is refused and disconnects nobody', async () => {
    const { fake, deps } = await withChannel();
    fake.voice.set(BEN, '600000000000000077');

    await run(fake, deps, { sub: 'kick', options: [userOption('member', BEN)] });

    expect(callsOf(fake, 'move_member')).toHaveLength(0);
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} I can’t see <@${BEN}> in your channel, so I didn’t disconnect them.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a kick aimed at somebody Proton has no voice record for says only what Proton can see', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'kick', options: [userOption('member', BEN)] });

    expect(callsOf(fake, 'move_member')).toHaveLength(0);
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} I can’t see <@${BEN}> in your channel, so I didn’t disconnect them.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a kick Discord refuses names the permission it needs', async () => {
    const { fake, deps } = await withChannel();
    fake.voice.set(BEN, CREATED);
    fake.refuse('move_member', 'discord_403', 'Discord refused.', 'failed_api');

    await run(fake, deps, { sub: 'kick', options: [userOption('member', BEN)] });

    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} Discord wouldn’t let me disconnect <@${BEN}>. I’m probably missing ` +
        'Move Members in this server, so ask an admin to check.',
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a kick of somebody who has already left voice says so instead of naming a permission', async () => {
    const { fake, deps } = await withChannel();
    fake.voice.set(BEN, CREATED);
    fake.refuse('move_member', 'discord_400', 'Discord refused.', 'failed_api');

    await run(fake, deps, { sub: 'kick', options: [userOption('member', BEN)] });

    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} <@${BEN}> has left voice, so there was no one to disconnect.`,
    );
  });

  test('a kick lost in transit names no permission and makes no claim either way', async () => {
    const { fake, deps } = await withChannel();
    fake.voice.set(BEN, CREATED);
    fake.refuse('move_member', 'transport_failure', 'I couldn’t reach Discord.', 'failed_api');

    await run(fake, deps, { sub: 'kick', options: [userOption('member', BEN)] });

    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} Couldn’t confirm that <@${BEN}> was disconnected. Check the ` +
        'channel before trying again.',
    );
  });

  test('a bot sitting in the channel can be kicked', async () => {
    const { fake, deps } = await withChannel();
    await botJoins(fake, CREATED);

    await run(fake, deps, { sub: 'kick', options: [userOption('member', MUSIC_BOT)] });

    expect(callsOf(fake, 'move_member')[0]).toMatchObject({
      targetId: MUSIC_BOT,
      payload: { userId: MUSIC_BOT, channelId: null },
    });
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
  });

  test('a bot in another voice channel cannot be kicked from here', async () => {
    const { fake, deps } = await withChannel();
    await botJoins(fake, '600000000000000077');

    await run(fake, deps, { sub: 'kick', options: [userOption('member', MUSIC_BOT)] });

    expect(callsOf(fake, 'move_member')).toHaveLength(0);
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a block whose disconnect is refused says the member is still connected', async () => {
    const { fake, row, deps } = await withChannel();
    fake.voice.set(BEN, CREATED);
    fake.refuse('move_member', 'missing_permission', 'I’m missing Move Members.');

    await run(fake, deps, { sub: 'block', options: [userOption('member', BEN)] });

    expect(await fake.repository.access(row.id)).toEqual([{ userId: BEN, kind: 'block' }]);
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} Blocked <@${BEN}> from your channel. Couldn’t disconnect ` +
        `<@${BEN}> because I’m missing Move Members in this server. Ask an admin to give it to me.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a block of somebody in another voice channel blocks without disconnecting', async () => {
    const { fake, row, deps } = await withChannel();
    fake.voice.set(BEN, '600000000000000077');

    await run(fake, deps, { sub: 'block', options: [userOption('member', BEN)] });

    expect(await fake.repository.access(row.id)).toEqual([{ userId: BEN, kind: 'block' }]);
    expect(callsOf(fake, 'move_member')).toHaveLength(0);
    expect(replyText(fake)).toBe(`${STATUS_SUCCESS_EMOJI} Blocked <@${BEN}> from your channel.`);
  });

  test('a block of somebody sitting in the channel disconnects them', async () => {
    const { fake, deps } = await withChannel();
    fake.voice.set(BEN, CREATED);

    await run(fake, deps, { sub: 'block', options: [userOption('member', BEN)] });

    expect(callsOf(fake, 'move_member')[0]).toMatchObject({
      targetId: BEN,
      payload: { channelId: null },
    });
  });

  test('kicking yourself points at /voice delete instead', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'kick', options: [userOption('member', ADA)] });

    expect(callsOf(fake, 'move_member')).toHaveLength(0);
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} Use \`/voice delete\` to close your channel.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('an invite whose overwrites never landed is red, not green', async () => {
    const { fake, deps } = await withChannel();
    fake.refuse('edit_channel', 'missing_permission', 'Manage Roles is missing');

    await run(fake, deps, { sub: 'invite', options: [userOption('member', BEN)] });

    expect(replyText(fake)).toContain('Couldn’t invite that member');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('an invite that lands names the member and the channel', async () => {
    const { fake, row, deps } = await withChannel();

    await run(fake, deps, { sub: 'invite', options: [userOption('member', BEN)] });

    expect(replyText(fake)).toContain(`<@${BEN}> can now join <#${row.channelId}>`);
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
  });

  test('deleting your own channel is green', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'delete' });

    expect(callsOf(fake, 'delete_channel')).toHaveLength(1);
    expect(replyText(fake)).toBe(`${STATUS_SUCCESS_EMOJI} Deleted your channel.`);
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
  });

  test('claiming a channel that still has an owner is refused', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'claim', userId: BEN });

    expect(replyText(fake)).toBe(`${STATUS_ERROR_EMOJI} <@${ADA}> still owns this channel.`);
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('claiming an ownerless channel is green', async () => {
    const { fake, row, deps } = await withChannel();
    await fake.repository.setOwner(row.id, null);

    await run(fake, deps, { sub: 'claim', userId: BEN });

    expect(fake.row(row.id).ownerId).toBe(BEN);
    expect(replyText(fake)).toBe(`${STATUS_SUCCESS_EMOJI} You own this channel now.`);
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
  });
});

describe('/voice acknowledges each interaction exactly once', () => {
  const cases: Array<[string, CommandCall, (fake: Fake) => void | Promise<void>]> = [
    [
      'a rename that lands',
      { sub: 'rename', options: [stringOption('name', 'Study room')] },
      () => {},
    ],
    ['an empty name', { sub: 'rename', options: [stringOption('name', '   ')] }, () => {}],
    [
      'a member who does not own it',
      { sub: 'rename', userId: BEN, options: [stringOption('name', 'x')] },
      () => {},
    ],
    [
      'a run outside a temporary channel',
      { sub: 'delete', channelId: '600000000000000099' },
      () => {},
    ],
    [
      'member control switched off',
      { sub: 'limit', options: [] },
      (fake) => {
        fake.ctx.config.ownerCommands = false;
      },
    ],
    ['a kick of yourself', { sub: 'kick', options: [userOption('member', ADA)] }, () => {}],
    ['a delete', { sub: 'delete' }, () => {}],
    ['a claim of an owned channel', { sub: 'claim', userId: BEN }, () => {}],
    ['a subcommand nobody knows', { sub: 'dance' }, () => {}],
  ];

  for (const [name, call, arrange] of cases) {
    test(`${name}: one private defer, then the answer as one private followup`, async () => {
      const { fake, deps } = await withChannel();
      await arrange(fake);

      await run(fake, deps, call);

      const initial = initialCallbacks(fake);
      expect(initial).toHaveLength(1);
      expect(initial[0]?.payload).toMatchObject({ callbackType: 5, ephemeral: true });

      const followups = callsOf(fake, 'interaction_followup');
      expect(followups).toHaveLength(1);
      expect(followups[0]?.payload).toMatchObject({
        applicationId: APPLICATION,
        interactionToken: 'tok',
        ephemeral: true,
      });
      expect(replyText(fake)).not.toBeNull();
    });
  }

  test('a /voice that cannot bind its store still answers once, after its defer', async () => {
    const fake = harness();

    await voiceCommand({}).handler(commandContext(fake, { sub: 'claim' }));

    expect(initialCallbacks(fake)).toHaveLength(1);
    expect(callsOf(fake, 'interaction_followup')).toHaveLength(1);
    expect(replyText(fake)).toContain('I can’t manage temporary voice channels right now');
  });

  test('without an application id there is no defer, and the one callback is the answer', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'delete', applicationId: null });

    const initial = initialCallbacks(fake);
    expect(initial).toHaveLength(1);
    expect(initial[0]?.payload.callbackType ?? 4).toBe(4);
    expect(initial[0]?.payload.ephemeral).toBe(true);
    expect(callsOf(fake, 'interaction_followup')).toHaveLength(0);
    expect(replyText(fake)).toBe(`${STATUS_SUCCESS_EMOJI} Deleted your channel.`);
  });

  test('a redelivered /voice reuses the same keys, so the executor dedupes it', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'claim', userId: BEN });
    const first = fake.calls.map((call) => call.idempotencyKey);
    fake.calls.length = 0;
    await run(fake, deps, { sub: 'claim', userId: BEN });

    expect(fake.calls.map((call) => call.idempotencyKey)).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });
});

const RENAMED = (key: string, path?: string) =>
  formatCommandLabel(key, path, key === 'voice' ? 'vc' : undefined);

async function runRenamed(fake: Fake, deps: ReturnType<typeof depsOf>, call: CommandCall) {
  await voiceCommand(deps).handler({ ...commandContext(fake, call), commandLabel: RENAMED });
}

const NOTHING_ALLOWED = Object.fromEntries(OWNER_CONTROLS.map((control) => [control, false]));

describe('/voice names its commands the way this server shows them', () => {
  test('a member who does not own the channel is pointed at the renamed claim', async () => {
    const { fake, deps } = await withChannel();

    await runRenamed(fake, deps, {
      sub: 'rename',
      userId: BEN,
      options: [stringOption('name', 'Mine now')],
    });

    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} This isn’t your channel. Only its owner can change it. If the ` +
        'owner has left, use `/vc claim`.',
    );
  });

  test('kicking yourself points at the renamed delete', async () => {
    const { fake, deps } = await withChannel();

    await runRenamed(fake, deps, { sub: 'kick', options: [userOption('member', ADA)] });

    expect(replyText(fake)).toBe(`${STATUS_ERROR_EMOJI} Use \`/vc delete\` to close your channel.`);
  });

  test('without a label source the refusal names /voice claim as it always has', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'rename', userId: BEN, options: [stringOption('name', 'x')] });

    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} This isn’t your channel. Only its owner can change it. If the ` +
        'owner has left, use `/voice claim`.',
    );
  });

  test('a panel with no buttons names the renamed command', async () => {
    const fake = harness({ hub: { allow: NOTHING_ALLOWED } });

    await fake.service.create({ ...fake.ctx, commandLabel: RENAMED }, fake.hub, member());

    expect(callsOf(fake, 'send')[0]?.payload.content).toBe(
      `### Temporary voice channel\n<@${ADA}> owns this channel.\nIts owner manages it with \`/vc\`.`,
    );
  });

  test('without a label source a panel with no buttons names /voice as it always has', async () => {
    const fake = harness({ hub: { allow: NOTHING_ALLOWED } });

    await fake.service.create(fake.ctx, fake.hub, member());

    expect(callsOf(fake, 'send')[0]?.payload.content).toBe(
      `### Temporary voice channel\n<@${ADA}> owns this channel.\nIts owner manages it with \`/voice\`.`,
    );
    expect(
      panelMessage({ hub: fake.hub, tempChannelId: 'row-1', ownerCommands: true, ownerId: null })
        .content,
    ).toEndWith('Its owner manages it with `/voice`.');
  });
});
