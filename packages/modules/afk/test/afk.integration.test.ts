import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import {
  BOT_PERMISSIONS,
  CHANNEL,
  DM_CHANNEL,
  GUILD,
  harness,
  MEMBER,
  mention,
  messageEvent,
  OTHER,
  stringOption,
} from './harness.ts';

describe('AFK over the real executor', () => {
  test('a member goes away, is pinged, comes back and is caught up', async () => {
    const h = harness();

    await h.run('set', [stringOption('reason', 'walking the dog')]);
    expect(h.nicknames()).toEqual([{ userId: MEMBER, nick: '[AFK] Bob' }]);

    await h.emit(
      messageEvent({ authorId: OTHER, mentions: [mention(MEMBER, { nick: '[AFK] Bob' })] }),
    );
    expect(h.sends()[0]?.body.content).toStartWith('**Bob** is AFK: walking the dog · <t:');

    await h.emit(messageEvent({ authorId: MEMBER, nick: '[AFK] Bob' }));

    const record = await h.store.get(GUILD, MEMBER);
    expect(record?.endedAt).not.toBeNull();
    expect(record).toMatchObject({ reason: null, previousNick: null, appliedNick: null });
    expect(h.nicknames().at(-1)).toEqual({ userId: MEMBER, nick: 'Bob' });
    expect(h.sends().find((sent) => sent.channelId === DM_CHANNEL)?.body.content).toContain(
      'You were pinged 1 time',
    );
    expect(h.sends().at(-1)?.body.content).toContain("I've sent you the 1 ping you missed.");
    expect(h.recorder.recorded).toEqual([]);
  });

  test('without Manage Nicknames or Send Messages it still tracks the member and names what is missing', async () => {
    const h = harness({ botPermissions: BOT_PERMISSIONS & ~Permissions.ManageNicknames });

    await h.run('set', [stringOption('reason', 'lunch')]);

    expect(await h.store.get(GUILD, MEMBER)).not.toBeNull();
    expect(h.nicknames()).toEqual([]);
    expect(h.lastFollowUp()).toContain('Manage Nicknames');

    h.botPermissions = BOT_PERMISSIONS & ~Permissions.ManageNicknames & ~Permissions.SendMessages;
    await h.emit(messageEvent({ authorId: OTHER, mentions: [mention(MEMBER)] }));

    expect(h.sends()).toEqual([]);
    expect(
      h.logs.some(
        (log) =>
          log.level === 'warn' &&
          log.message.includes('Send Messages') &&
          log.message.includes(`<#${CHANNEL}>`),
      ),
    ).toBe(true);
  });
});
