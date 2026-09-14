import { describe, expect, test } from 'bun:test';
import { RedisGuildStateStore } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise, type RawDispatch } from '@proton/gateway/normaliser';
import type { Redis } from 'ioredis';
import { type GuildRegistrar, GuildStateConsumer } from '../src/guild-state-consumer.ts';

const BOT = '1200000000000000001';
const GUILD = '900000000000000001';
const NEWCOMER = '100000000000000002';
const SECOND = '100000000000000003';

class FakeRedis {
  readonly values = new Map<string, string>();
  failNextWrite = false;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    const onlyIfAbsent = args.includes('NX');
    if (onlyIfAbsent && this.values.has(key)) return null;
    if (this.failNextWrite && !onlyIfAbsent) {
      this.failNextWrite = false;
      throw new Error('redis write timed out');
    }

    this.values.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

const registrar: GuildRegistrar = { ensure: async () => {}, markLeft: async () => {} };

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function only(raw: RawDispatch, sessionId?: string) {
  const event = normalise(raw, { sessionId })[0];
  if (!event) throw new Error(`${raw.t} did not normalise`);
  return event;
}

function joined(userId = NEWCOMER, joinedAt = '2026-08-14T09:00:00.000000+00:00') {
  const raw = dispatch('guildMemberAdd');
  return only({ ...raw, d: { ...raw.d, user: { id: userId }, joined_at: joinedAt } });
}

function left(userId: string, sequence: number) {
  return only(
    { t: 'GUILD_MEMBER_REMOVE', s: sequence, op: 0, d: { guild_id: GUILD, user: { id: userId } } },
    'session-a',
  );
}

async function seeded() {
  const redis = new FakeRedis();
  const store = new RedisGuildStateStore(redis as unknown as Redis);
  const consumer = new GuildStateConsumer({
    bus: { publish: async () => {}, subscribe: () => ({ group: 'x', close: async () => {} }) },
    store,
    registrar,
    botUserId: BOT,
    logger: silent,
  });

  await consumer.handle(only(dispatch('guildCreate')));

  return { redis, consumer, memberCount: async () => (await store.get(GUILD))?.memberCount };
}

describe('the member count behind welcome placeholders and counters', () => {
  test('starts from the member_count GUILD_CREATE carried', async () => {
    const { memberCount } = await seeded();

    expect(await memberCount()).toBe(3);
  });

  test('moves once when the bus redelivers a join whose ack was lost', async () => {
    const { consumer, memberCount } = await seeded();
    const join = joined();

    await consumer.handle(join);
    await consumer.handle(join);

    expect(await memberCount()).toBe(4);
  });

  test('moves once when the bus redelivers a leave whose ack was lost', async () => {
    const { consumer, memberCount } = await seeded();
    const leave = left(NEWCOMER, 12);

    await consumer.handle(leave);
    await consumer.handle(leave);

    expect(await memberCount()).toBe(2);
  });

  test('counts two different joins and a leave, each exactly once', async () => {
    const { consumer, memberCount } = await seeded();

    await consumer.handle(joined());
    await consumer.handle(joined(SECOND, '2026-08-14T09:05:00.000000+00:00'));
    await consumer.handle(left(NEWCOMER, 12));

    expect(await memberCount()).toBe(4);
  });

  test('still counts a join whose first write failed, because the failure released its claim', async () => {
    const { redis, consumer, memberCount } = await seeded();
    const join = joined();

    redis.failNextWrite = true;
    await expect(consumer.handle(join)).rejects.toThrow('redis write timed out');
    expect(await memberCount()).toBe(3);

    await consumer.handle(join);

    expect(await memberCount()).toBe(4);
  });

  test('is re-baselined by the next GUILD_CREATE, which a join redelivered afterwards does not move', async () => {
    const { consumer, memberCount } = await seeded();
    const join = joined();

    await consumer.handle(join);
    expect(await memberCount()).toBe(4);

    await consumer.handle(only(dispatch('guildCreate')));
    expect(await memberCount()).toBe(3);

    await consumer.handle(join);
    expect(await memberCount()).toBe(3);
  });
});
