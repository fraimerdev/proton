import { describe, expect, test } from 'bun:test';
import type { ProtonEvent } from '@proton/core';
import { handleVoiceState, presenceOf } from '../src/voice.ts';
import {
  BEN,
  CREATED,
  callsOf,
  depsOf,
  type Fake,
  GUILD,
  HUB,
  harness,
  member,
} from './harness.ts';

const ELSEWHERE = '600000000000000077';
const MUSIC_BOT = '800000000000000009';

function voice(
  userId: string,
  channelId: string | null,
  occurredAt: number,
  bot = false,
): ProtonEvent {
  return {
    id: `voice.state_updated:${userId}:${channelId ?? 'disconnect'}:${occurredAt}`,
    type: 'voice.state_updated',
    guildId: GUILD,
    occurredAt,
    payload: {
      user_id: userId,
      channel_id: channelId,
      member: { user: { id: userId, username: bot ? 'music' : 'ben', bot } },
    },
  };
}

async function deliver(fake: Fake, event: ProtonEvent): Promise<void> {
  await handleVoiceState(
    event,
    fake.ctx,
    fake.service,
    fake.repository,
    presenceOf(fake.presence),
    depsOf(fake),
  );
}

async function withChannel() {
  const fake = harness();
  const outcome = await fake.service.create(fake.ctx, fake.hub, member());
  if (!('created' in outcome)) throw new Error('expected a channel');

  fake.calls.length = 0;
  return { fake, row: outcome.created };
}

describe('a redelivered voice event', () => {
  test('a join replayed after a later move leaves the member where they went', async () => {
    const { fake, row } = await withChannel();
    const joined = voice(BEN, CREATED, 1_000);

    await deliver(fake, joined);
    await deliver(fake, voice(BEN, ELSEWHERE, 2_000));
    await deliver(fake, joined);

    expect(await fake.presence.locate(GUILD, BEN)).toBe(ELSEWHERE);
    expect(await fake.presence.occupants(GUILD, CREATED)).toEqual([]);

    fake.calls.length = 0;
    expect(await fake.service.disconnect(fake.ctx, row, BEN)).toBe('not_in_channel');
    expect(callsOf(fake, 'move_member')).toHaveLength(0);
  });

  test('a join replayed after the member left voice does not put them back', async () => {
    const { fake } = await withChannel();
    const joined = voice(BEN, CREATED, 1_000);

    await deliver(fake, joined);
    await deliver(fake, voice(BEN, null, 2_000));
    await deliver(fake, joined);

    expect(await fake.presence.locate(GUILD, BEN)).toBeNull();
    expect(await fake.presence.occupants(GUILD, CREATED)).toEqual([]);
  });

  test('a newer event still moves the member', async () => {
    const { fake } = await withChannel();

    await deliver(fake, voice(BEN, ELSEWHERE, 1_000));
    await deliver(fake, voice(BEN, CREATED, 2_000));

    expect(await fake.presence.locate(GUILD, BEN)).toBe(CREATED);
    expect(await fake.presence.occupants(GUILD, CREATED)).toEqual([BEN]);
  });
});

describe('an update that does not move the member', () => {
  test('refreshes where Proton saw them, so the entry does not lapse while they sit there', async () => {
    const { fake } = await withChannel();

    await deliver(fake, voice(BEN, CREATED, 1_000));
    await deliver(fake, voice(BEN, CREATED, 5_000));

    expect(await fake.presence.where(GUILD, BEN)).toEqual({ channelId: CREATED, at: 5_000 });
    expect(await fake.presence.occupants(GUILD, CREATED)).toEqual([BEN]);
  });
});

describe('bots', () => {
  test('are located, so an owner can disconnect one, but never counted as occupants', async () => {
    const { fake } = await withChannel();

    await deliver(fake, voice(MUSIC_BOT, CREATED, 1_000, true));

    expect(await fake.presence.locate(GUILD, MUSIC_BOT)).toBe(CREATED);
    expect(await fake.presence.occupants(GUILD, CREATED)).toEqual([]);
  });

  test('joining a creator channel makes nothing', async () => {
    const fake = harness();

    await deliver(fake, voice(MUSIC_BOT, HUB, 1_000, true));

    expect(callsOf(fake, 'create_channel')).toHaveLength(0);
    expect(fake.repository.rows.size).toBe(0);
  });
});
