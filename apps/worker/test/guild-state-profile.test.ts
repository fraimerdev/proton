import { describe, expect, test } from 'bun:test';
import { type EventType, type GuildState, RedisGuildStateStore } from '@proton/core';
import { dispatch } from '@proton/fixtures';
import { normalise, type RawDispatch } from '@proton/gateway/normaliser';
import type { Redis } from 'ioredis';
import { type GuildRegistrar, GuildStateConsumer } from '../src/guild-state-consumer.ts';

const BOT = '1200000000000000001';
const GUILD = '900000000000000001';
const ICON = 'a_0123456789abcdef0123456789abcdef';
const NEW_ICON = 'fedcba9876543210fedcba9876543210';
const BANNER = '0123456789abcdef0123456789abcdef';

class FakeRedis {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    if (args.includes('NX') && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }
}

const registrar: GuildRegistrar = { ensure: async () => {}, markLeft: async () => {} };

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function at(raw: RawDispatch, occurredAt: number) {
  const event = normalise(raw, { now: () => occurredAt })[0];
  if (!event) throw new Error(`${raw.t} did not normalise`);
  return event;
}

function guildCreate(occurredAt: number, changes: Record<string, unknown> = {}) {
  const raw = dispatch('guildCreate');
  return at(
    {
      ...raw,
      d: {
        ...raw.d,
        icon: ICON,
        banner: BANNER,
        description: 'A place for testing',
        premium_subscription_count: 14,
        premium_tier: 2,
        ...changes,
      },
    },
    occurredAt,
  );
}

function guildUpdate(occurredAt: number, changes: Record<string, unknown> = {}) {
  const raw = dispatch('guildUpdate');
  return at({ ...raw, d: { ...raw.d, ...changes } }, occurredAt);
}

function consumerOver(store: RedisGuildStateStore, subscribed: string[] = []) {
  return new GuildStateConsumer({
    bus: {
      publish: async () => {},
      subscribe: (_group: string, types: readonly EventType[]) => {
        subscribed.push(...types);
        return { group: 'guild-state', close: async () => {} };
      },
    },
    store,
    registrar,
    botUserId: BOT,
    logger: silent,
  });
}

async function seeded(createdAt = 1_000) {
  const store = new RedisGuildStateStore(new FakeRedis() as unknown as Redis);
  const consumer = consumerOver(store);
  await consumer.handle(guildCreate(createdAt));

  const stored = async (): Promise<GuildState> => {
    const state = await store.get(GUILD);
    if (!state) throw new Error('no guild state was stored');
    return state;
  };

  return { store, consumer, stored };
}

function withoutUpdatedAt({ updatedAt: _updatedAt, ...rest }: GuildState) {
  return rest;
}

describe('the server profile behind server placeholders', () => {
  test('is subscribed to, so GUILD_UPDATE reaches guild state at all', () => {
    const subscribed: string[] = [];
    const store = new RedisGuildStateStore(new FakeRedis() as unknown as Redis);

    consumerOver(store, subscribed).start();

    expect(subscribed).toContain('entity.guild_updated');
  });

  test('starts from the icon, banner, description and boosts GUILD_CREATE carried', async () => {
    const { stored } = await seeded(1_000);

    expect(await stored()).toMatchObject({
      name: 'Proton Test Guild',
      iconHash: ICON,
      bannerHash: BANNER,
      description: 'A place for testing',
      boostCount: 14,
      boostTier: 2,
      profileAt: 1_000,
    });
  });

  test('follows a rename on GUILD_UPDATE instead of waiting for the next reconnect', async () => {
    const { consumer, stored } = await seeded();

    await consumer.handle(guildUpdate(2_000));

    expect(await stored()).toMatchObject({ name: 'Proton Test', boostTier: 0, profileAt: 2_000 });
  });

  test('takes a new icon, a removed banner, a cleared description and a new boost count', async () => {
    const { consumer, stored } = await seeded();

    await consumer.handle(
      guildUpdate(2_000, {
        icon: NEW_ICON,
        banner: null,
        description: null,
        premium_subscription_count: 15,
      }),
    );

    expect(await stored()).toMatchObject({
      iconHash: NEW_ICON,
      bannerHash: null,
      description: null,
      boostCount: 15,
    });
  });

  test('keeps every field a GUILD_UPDATE did not carry, the boost count included', async () => {
    const { consumer, stored } = await seeded();

    await consumer.handle(guildUpdate(2_000));

    expect(await stored()).toMatchObject({
      iconHash: ICON,
      bannerHash: BANNER,
      description: 'A place for testing',
      boostCount: 14,
    });
  });

  test('is unchanged by a GUILD_UPDATE the gateway redelivers on RESUME', async () => {
    const { consumer, stored } = await seeded();
    const update = guildUpdate(2_000, { name: 'Renamed', icon: NEW_ICON });

    await consumer.handle(update);
    const once = withoutUpdatedAt(await stored());
    await consumer.handle(update);

    expect(withoutUpdatedAt(await stored())).toEqual(once);
  });

  test('ignores an update that happened before the GUILD_CREATE it was handled after', async () => {
    const { consumer, stored } = await seeded(1_000);

    await consumer.handle(guildUpdate(900, { name: 'Stale', premium_subscription_count: 1 }));

    expect(await stored()).toMatchObject({ name: 'Proton Test Guild', boostCount: 14 });
  });

  test('measures staleness in gateway time, so a queue backlog cannot make a newer update look old', async () => {
    const { consumer, stored } = await seeded(1_000);

    await consumer.handle(guildUpdate(1_005, { name: 'Fresh' }));

    expect((await stored()).name).toBe('Fresh');
  });

  test('keeps the newer of two updates the bus delivers out of order', async () => {
    const { consumer, stored } = await seeded();

    await consumer.handle(guildUpdate(3_000, { name: 'Newer' }));
    await consumer.handle(guildUpdate(2_000, { name: 'Older' }));

    expect((await stored()).name).toBe('Newer');
  });

  test('is re-baselined by the next GUILD_CREATE, after which an older update is ignored', async () => {
    const { consumer, stored } = await seeded(1_000);

    await consumer.handle(guildUpdate(2_000, { name: 'Renamed' }));
    await consumer.handle(guildCreate(3_000, { premium_subscription_count: 20 }));
    expect(await stored()).toMatchObject({ name: 'Proton Test Guild', boostCount: 20 });

    await consumer.handle(guildUpdate(2_500, { name: 'Late' }));
    expect((await stored()).name).toBe('Proton Test Guild');
  });

  test('leaves roles, channels, the bot’s roles and the member count alone', async () => {
    const { consumer, stored } = await seeded();
    const before = await stored();

    await consumer.handle(guildUpdate(2_000, { name: 'Renamed' }));

    const after = await stored();
    expect(after.roles).toEqual(before.roles);
    expect(after.channels).toEqual(before.channels);
    expect(after.botRoleIds).toEqual(before.botRoleIds);
    expect(after.memberCount).toBe(before.memberCount);
  });

  test('drops an update for a guild it holds no state for, rather than writing a partial one', async () => {
    const store = new RedisGuildStateStore(new FakeRedis() as unknown as Redis);

    await consumerOver(store).handle(guildUpdate(2_000));

    expect(await store.get(GUILD)).toBeNull();
  });

  test('ignores an update that carries no guild id', async () => {
    const { consumer, stored } = await seeded();

    await consumer.handle({
      id: 'entity.guild_updated:without-guild',
      type: 'entity.guild_updated',
      guildId: null,
      occurredAt: 2_000,
      payload: { name: 'Nowhere' },
    });

    expect((await stored()).name).toBe('Proton Test Guild');
  });

  test('ignores an icon hash shaped like a path, so a payload cannot steer the CDN link', async () => {
    const { consumer, stored } = await seeded();

    await consumer.handle(guildUpdate(2_000, { icon: '../../attachments/1/2/x.png?size=4096' }));

    expect((await stored()).iconHash).toBe(ICON);
  });

  test('reads a JSON payload with a __proto__ key without polluting objects or the profile', async () => {
    const { consumer, stored } = await seeded();
    const payload = JSON.parse(
      `{"id":"${GUILD}","__proto__":{"polluted":true,"name":"Injected","icon":"${NEW_ICON}"},"premium_tier":1}`,
    ) as unknown;

    await consumer.handle({
      id: 'entity.guild_updated:proto',
      type: 'entity.guild_updated',
      guildId: GUILD,
      occurredAt: 2_000,
      payload,
    });

    expect(await stored()).toMatchObject({
      name: 'Proton Test Guild',
      iconHash: ICON,
      boostTier: 1,
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
