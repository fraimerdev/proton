import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { buildGuildState, parseGuildProfile } from '../../src/guild-state/build.ts';
import { RedisGuildStateStore } from '../../src/guild-state/redis.ts';
import type { GuildState } from '../../src/guild-state/types.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const AFK = '500000000000000010';
const OTHER_AFK = '500000000000000011';
const CREATED_AT = 1_800_000_000_000;

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

function guildCreate(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GUILD,
    name: 'Proton Test Guild',
    owner_id: OWNER,
    roles: [{ id: GUILD, permissions: '0', position: 0 }],
    channels: [],
    members: [{ user: { id: BOT }, roles: [] }],
    ...extra,
  };
}

function built(extra: Record<string, unknown> = {}): GuildState {
  const state = buildGuildState(guildCreate(extra), BOT, CREATED_AT);
  if (!state) throw new Error('expected buildGuildState to yield state');
  return state;
}

function build(): { redis: FakeRedis; store: RedisGuildStateStore } {
  const redis = new FakeRedis();
  return { redis, store: new RedisGuildStateStore(redis as unknown as Redis) };
}

async function loaded(store: RedisGuildStateStore): Promise<GuildState> {
  const held = await store.get(GUILD);
  if (!held) throw new Error('nothing loaded');
  return held;
}

describe('the AFK channel GUILD_CREATE carries', () => {
  test('is kept, so voice counting can leave idle members out', () => {
    expect(built({ afk_channel_id: AFK }).afkChannelId).toBe(AFK);
  });

  test('a server with none keeps null, so "none set" stays distinct from "never seen"', () => {
    const state = built({ afk_channel_id: null });

    expect(state.afkChannelId).toBeNull();
    expect('afkChannelId' in state).toBe(true);
  });

  test('a payload that does not carry it leaves the field absent', () => {
    expect('afkChannelId' in built()).toBe(false);
  });

  test.each([
    ['a channel name', 'afk'],
    ['a number', 42],
    ['empty', ''],
    ['an object', { id: AFK }],
  ])('an AFK channel that is %s is ignored', (_label, value) => {
    expect('afkChannelId' in built({ afk_channel_id: value })).toBe(false);
  });
});

describe('parseGuildProfile reading GUILD_UPDATE', () => {
  test('reads a new AFK channel and a cleared one', () => {
    expect(parseGuildProfile({ afk_channel_id: AFK })).toEqual({ afkChannelId: AFK });
    expect(parseGuildProfile({ afk_channel_id: null })).toEqual({ afkChannelId: null });
  });

  test('reads only the payload’s own key, so a polluted prototype cannot supply one', () => {
    const inherited = Object.create({ afk_channel_id: AFK }) as Record<string, unknown>;

    expect(Object.keys(parseGuildProfile(inherited))).toEqual([]);
  });
});

describe('the AFK channel in Redis', () => {
  test('survives the trip, set or cleared', async () => {
    const { store } = build();

    await store.put(built({ afk_channel_id: AFK }));
    expect((await loaded(store)).afkChannelId).toBe(AFK);

    await store.put(built({ afk_channel_id: null }));
    const cleared = await loaded(store);
    expect(cleared.afkChannelId).toBeNull();
    expect('afkChannelId' in cleared).toBe(true);
  });

  test('a snapshot stored before the AFK channel was kept still loads, without one', async () => {
    const { redis, store } = build();
    await store.put(built({ afk_channel_id: AFK }));

    const [key, stored] = [...redis.values.entries()][0] ?? [];
    if (key === undefined || stored === undefined) throw new Error('nothing was stored');
    const wire = JSON.parse(stored) as Record<string, unknown>;
    delete wire.afkChannelId;
    redis.values.set(key, JSON.stringify(wire));

    const held = await loaded(store);
    expect('afkChannelId' in held).toBe(false);
    expect(held.name).toBe('Proton Test Guild');
  });

  test('a stored AFK channel of the wrong type is dropped', async () => {
    const { redis, store } = build();
    await store.put(built({ afk_channel_id: AFK }));

    const [key, stored] = [...redis.values.entries()][0] ?? [];
    if (key === undefined || stored === undefined) throw new Error('nothing was stored');
    redis.values.set(key, JSON.stringify({ ...JSON.parse(stored), afkChannelId: 42 }));

    expect('afkChannelId' in (await loaded(store))).toBe(false);
  });
});

describe('a GUILD_UPDATE patch', () => {
  const update = (at: number, payload: Record<string, unknown>) =>
    ({ kind: 'guild.profile', at, profile: parseGuildProfile(payload) }) as const;

  test('moves the AFK channel', async () => {
    const { store } = build();
    await store.put(built({ afk_channel_id: AFK }));

    await store.patch(GUILD, update(CREATED_AT + 1_000, { afk_channel_id: OTHER_AFK }));

    expect((await loaded(store)).afkChannelId).toBe(OTHER_AFK);
  });

  test('clears it when the server removes its AFK channel', async () => {
    const { store } = build();
    await store.put(built({ afk_channel_id: AFK }));

    await store.patch(GUILD, update(CREATED_AT + 1_000, { afk_channel_id: null }));

    expect((await loaded(store)).afkChannelId).toBeNull();
  });

  test('sets it on a snapshot stored before the field existed', async () => {
    const { store } = build();
    await store.put(built());

    await store.patch(GUILD, update(CREATED_AT + 1_000, { afk_channel_id: AFK }));

    expect((await loaded(store)).afkChannelId).toBe(AFK);
  });

  test('keeps it when the update did not carry one', async () => {
    const { store } = build();
    await store.put(built({ afk_channel_id: AFK }));

    await store.patch(GUILD, update(CREATED_AT + 1_000, { name: 'Renamed' }));

    expect(await loaded(store)).toMatchObject({ name: 'Renamed', afkChannelId: AFK });
  });

  test('ignores an update older than the stored state, so a late delivery cannot roll it back', async () => {
    const { store } = build();
    await store.put(built({ afk_channel_id: AFK }));

    await store.patch(GUILD, update(CREATED_AT - 1, { afk_channel_id: OTHER_AFK }));

    expect((await loaded(store)).afkChannelId).toBe(AFK);
  });
});
