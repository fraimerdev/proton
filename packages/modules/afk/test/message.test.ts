import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { fromHuman, readMemberLeft, readMessage } from '../src/message.ts';
import { MEMBER, memberLeft, mention, messageEvent, OTHER } from './harness.ts';

function read(event: ProtonEvent) {
  const message = readMessage(event);
  if (!message) throw new Error('the message could not be read');
  return message;
}

describe('readMessage', () => {
  test('reads the recorded MESSAGE_CREATE, which carries no member', () => {
    const raw = dispatch('messageCreate').d;
    const author = raw.author as { id: string; bot?: boolean };

    const message = read({
      id: `message.created:${String(raw.id)}`,
      type: 'message.created',
      guildId: String(raw.guild_id),
      occurredAt: Date.parse(String(raw.timestamp)),
      payload: raw,
    });

    expect(message).toMatchObject({
      messageId: raw.id,
      channelId: raw.channel_id,
      authorId: author.id,
      isBot: author.bot === true,
      isWebhook: false,
      nick: undefined,
      roleIds: null,
      mentions: [],
    });
  });

  test('tells no member apart from a member with no nickname', () => {
    expect(read(messageEvent({ member: false })).nick).toBeUndefined();
    expect(read(messageEvent({ nick: null })).nick).toBeNull();
    expect(read(messageEvent({ nick: '[AFK] Bob' })).nick).toBe('[AFK] Bob');
  });

  test('a member whose nickname was not sent is unknown, not nickless', () => {
    const event = messageEvent({ nick: 'Bob' });
    const member = (event.payload as { member: Record<string, unknown> }).member;

    Reflect.deleteProperty(member, 'nick');
    expect(read(event).nick).toBeUndefined();

    member.nick = 7;
    expect(read(event).nick).toBeUndefined();
  });

  test('reads each mentioned user once, with their nickname when Discord sent one', () => {
    const message = read(
      messageEvent({
        mentions: [
          mention(MEMBER, { nick: 'Bob', globalName: 'Robert' }),
          mention(MEMBER, { nick: 'Bob' }),
          mention(OTHER, { bot: true }),
        ],
      }),
    );

    expect(message.mentions).toEqual([
      { id: MEMBER, bot: false, username: 'mentioned', globalName: 'Robert', nick: 'Bob' },
      { id: OTHER, bot: true, username: 'mentioned', globalName: null, nick: null },
    ]);
  });

  test('refuses a payload with no author or id', () => {
    expect(
      readMessage({
        id: 'message.created:x',
        type: 'message.created',
        guildId: '900000000000000001',
        occurredAt: 0,
        payload: { id: '1' },
      }),
    ).toBeNull();
  });
});

describe('fromHuman', () => {
  test('a person’s message or reply counts; bots, webhooks and system messages do not', () => {
    expect(fromHuman(read(messageEvent()))).toBe(true);
    expect(fromHuman(read(messageEvent({ type: 19 })))).toBe(true);
    expect(fromHuman(read(messageEvent({ bot: true })))).toBe(false);
    expect(fromHuman(read(messageEvent({ webhook: true })))).toBe(false);
    expect(fromHuman(read(messageEvent({ type: 7 })))).toBe(false);
  });
});

describe('readMemberLeft', () => {
  test('reads the user who left', () => {
    expect(readMemberLeft(memberLeft(MEMBER))).toBe(MEMBER);
  });
});
