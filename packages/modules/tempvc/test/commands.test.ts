import { describe, expect, test } from 'bun:test';
import {
  STATUS_ERROR_COLOUR,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_COLOUR,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import { voiceCommand } from '../src/commands.ts';
import {
  ADA,
  BEN,
  type CommandCall,
  callsOf,
  commandContext,
  depsOf,
  type Fake,
  type HarnessOptions,
  harness,
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

describe('/voice answers with a status embed', () => {
  test('a rename that lands is green and names the new name', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'rename', options: [stringOption('name', 'Study room')] });

    expect(callsOf(fake, 'edit_channel')[0]?.payload.name).toBe('Study room');
    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} Your channel has been renamed to **Study room**.`,
    );
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
  });

  test('a rename Discord refuses is red and keeps the reason out of the reply', async () => {
    const { fake, deps } = await withChannel();
    fake.refuse('edit_channel', 'missing_permission', 'Manage Channels is missing');

    await run(fake, deps, { sub: 'rename', options: [stringOption('name', 'Study room')] });

    expect(replyText(fake)).toContain('I could not rename your channel');
    expect(replyText(fake)).not.toContain('Manage Channels is missing');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('an empty name is refused before Discord is called', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'rename', options: [stringOption('name', '   ')] });

    expect(callsOf(fake, 'edit_channel')).toHaveLength(0);
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} A channel needs a name — that one was empty.`,
    );
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
    expect(replyText(fake)).toContain('That channel is not yours');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('running it outside a temporary channel is refused', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, {
      sub: 'rename',
      channelId: '600000000000000099',
      options: [stringOption('name', 'Study room')],
    });

    expect(replyText(fake)).toContain('Run this from inside a temporary voice channel');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a server with member control disabled is refused', async () => {
    const { fake, deps } = await withChannel();
    fake.ctx.config.ownerCommands = false;

    await run(fake, deps, { sub: 'rename', options: [stringOption('name', 'Study room')] });

    expect(replyText(fake)).toContain('turned off member control of temporary channels');
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a control the admin disabled names the control', async () => {
    const { fake, deps } = await withChannel();
    fake.ctx.config.hubs[0] = { ...fake.hub, allow: { ...fake.hub.allow, kick: false } };

    await run(fake, deps, { sub: 'kick', options: [userOption('member', BEN)] });

    expect(callsOf(fake, 'move_member')).toHaveLength(0);
    expect(replyText(fake)).toBe(
      `${STATUS_ERROR_EMOJI} This server has switched **kick** off for these channels.`,
    );
    expect(replyColour(fake)).toBe(STATUS_ERROR_COLOUR);
  });

  test('a kick that lands names the member', async () => {
    const { fake, deps } = await withChannel();

    await run(fake, deps, { sub: 'kick', options: [userOption('member', BEN)] });

    expect(callsOf(fake, 'move_member')[0]?.payload.channelId).toBeNull();
    expect(replyText(fake)).toBe(
      `${STATUS_SUCCESS_EMOJI} <@${BEN}> has been disconnected from your channel.`,
    );
    expect(replyColour(fake)).toBe(STATUS_SUCCESS_COLOUR);
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

    expect(replyText(fake)).toContain('I could not invite that member');
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
    expect(replyText(fake)).toBe(`${STATUS_SUCCESS_EMOJI} Your channel has been deleted.`);
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
