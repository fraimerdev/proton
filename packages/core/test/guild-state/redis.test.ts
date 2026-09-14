import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { Redis } from 'ioredis';
import { CHANNEL_TYPES, isThreadChannel } from '../../src/guild-state/channel-types.ts';
import { RedisGuildStateStore } from '../../src/guild-state/redis.ts';
import type { ChannelState, GuildState, GuildStatePatch } from '../../src/guild-state/types.ts';
import { Permissions } from '../../src/permissions/bits.ts';
import type { GuildRole, Overwrite } from '../../src/permissions/compute.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const ROLE = '410000000000000005';
const SUPPORT = '500000000000000001';
const THREAD = '600000000000000001';

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly expiresAt = new Map<string, number>();
  now = 0;
  failNextWrite = false;

  #purge(key: string): void {
    const expiry = this.expiresAt.get(key);
    if (expiry !== undefined && expiry <= this.now) {
      this.values.delete(key);
      this.expiresAt.delete(key);
    }
  }

  purgeExpired(): void {
    for (const key of [...this.values.keys()]) this.#purge(key);
  }

  async get(key: string): Promise<string | null> {
    this.#purge(key);
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    this.#purge(key);
    const onlyIfAbsent = args.includes('NX');
    if (onlyIfAbsent && this.values.has(key)) return null;
    if (this.failNextWrite && !onlyIfAbsent) {
      this.failNextWrite = false;
      throw new Error('redis write timed out');
    }

    this.values.set(key, value);
    this.expiresAt.delete(key);
    const seconds = args.indexOf('EX');
    if (seconds >= 0) this.expiresAt.set(key, this.now + Number(args[seconds + 1]) * 1000);
    const millis = args.indexOf('PX');
    if (millis >= 0) this.expiresAt.set(key, this.now + Number(args[millis + 1]));
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.#purge(key);
    this.expiresAt.delete(key);
    return this.values.delete(key) ? 1 : 0;
  }
}

function build(): { redis: FakeRedis; store: RedisGuildStateStore } {
  const redis = new FakeRedis();
  return { redis, store: new RedisGuildStateStore(redis as unknown as Redis) };
}

function state(overrides: Partial<GuildState> = {}): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([[ROLE, { id: ROLE, permissions: Permissions.BanMembers, position: 5 }]]),
    botRoleIds: [ROLE],
    channels: new Map<string, ChannelState>([
      [
        SUPPORT,
        {
          id: SUPPORT,
          parentId: null,
          type: CHANNEL_TYPES.guildText,
          name: 'support',
          overwrites: [],
        },
      ],
      [THREAD, { id: THREAD, parentId: SUPPORT, type: CHANNEL_TYPES.publicThread, overwrites: [] }],
    ]),
    name: 'Proton Test Guild',
    memberCount: 42,
    updatedAt: 1_800_000_000_000,
    ...overrides,
  };
}

describe('what survives the trip through Redis', () => {
  test('a thread stays a thread, so the reader can still require the thread permission bit', async () => {
    const { store } = build();
    await store.put(state());

    expect(isThreadChannel((await store.get(GUILD))?.channels.get(THREAD))).toBe(true);
  });

  test('a thread keeps the parent whose overwrites are the only ones governing it', async () => {
    const { store } = build();
    await store.put(state());

    expect((await store.get(GUILD))?.channels.get(THREAD)?.parentId).toBe(SUPPORT);
  });

  test('a channel keeps its name, so counters are not renamed every refresh and honeypot can rename', async () => {
    const { store } = build();
    await store.put(state());

    expect((await store.get(GUILD))?.channels.get(SUPPORT)?.name).toBe('support');
  });

  test('a snapshot stored before channel names were kept still loads, without a name', async () => {
    const { redis, store } = build();
    await store.put(state());

    const [key, stored] = [...redis.values.entries()][0] ?? [];
    if (key === undefined || stored === undefined) throw new Error('nothing was stored');
    const wire = JSON.parse(stored) as { channels: Record<string, unknown>[] };
    for (const channel of wire.channels) delete channel.name;
    redis.values.set(key, JSON.stringify(wire));

    const loaded = (await store.get(GUILD))?.channels.get(SUPPORT);
    expect(loaded?.parentId).toBeNull();
    expect(loaded !== undefined && 'name' in loaded).toBe(false);
  });

  test('the guild name survives, so a welcome message does not fall back to "this server"', async () => {
    const { store } = build();
    await store.put(state());

    expect((await store.get(GUILD))?.name).toBe('Proton Test Guild');
  });

  test('the member count survives, so a welcome message does not greet member #0', async () => {
    const { store } = build();
    await store.put(state());

    expect((await store.get(GUILD))?.memberCount).toBe(42);
  });

  test('a Discord-managed role stays managed, so nothing offers to assign it by hand', async () => {
    const { store } = build();
    await store.put(
      state({
        roles: new Map([[ROLE, { id: ROLE, permissions: 0n, position: 5, managed: true }]]),
      }),
    );

    expect((await store.get(GUILD))?.roles.get(ROLE)?.managed).toBe(true);
  });
});

describe('incremental channel patches', () => {
  test('a thread created after GUILD_CREATE is added to the cached channels', async () => {
    const { store } = build();
    await store.put(state({ channels: new Map() }));

    await store.patch(GUILD, {
      kind: 'channel.upsert',
      channel: {
        id: THREAD,
        parentId: SUPPORT,
        type: CHANNEL_TYPES.publicThread,
        overwrites: [],
      },
    });

    expect((await store.get(GUILD))?.channels.get(THREAD)?.parentId).toBe(SUPPORT);
  });

  test('re-applying the same upsert leaves one entry, since the gateway redelivers', async () => {
    const { store } = build();
    await store.put(state({ channels: new Map() }));

    const channel: ChannelState = {
      id: THREAD,
      parentId: SUPPORT,
      type: CHANNEL_TYPES.publicThread,
      overwrites: [],
    };
    await store.patch(GUILD, { kind: 'channel.upsert', channel });
    await store.patch(GUILD, { kind: 'channel.upsert', channel });

    expect((await store.get(GUILD))?.channels.size).toBe(1);
  });

  test('an upsert replaces the overwrites it arrived with rather than merging them', async () => {
    const { store } = build();
    await store.put(
      state({
        channels: new Map<string, ChannelState>([
          [
            SUPPORT,
            {
              id: SUPPORT,
              parentId: null,
              type: CHANNEL_TYPES.guildText,
              overwrites: [{ id: ROLE, type: 0, allow: Permissions.ManageMessages, deny: 0n }],
            },
          ],
        ]),
      }),
    );

    await store.patch(GUILD, {
      kind: 'channel.upsert',
      channel: {
        id: SUPPORT,
        parentId: null,
        type: CHANNEL_TYPES.guildText,
        overwrites: [{ id: ROLE, type: 0, allow: 0n, deny: Permissions.ManageMessages }],
      },
    });

    const loaded = (await store.get(GUILD))?.channels.get(SUPPORT);
    expect(loaded?.overwrites).toHaveLength(1);
    expect(loaded?.overwrites[0]?.allow).toBe(0n);
    expect(loaded?.overwrites[0]?.deny).toBe(Permissions.ManageMessages);
  });

  test('a deletion removes the channel, so a stale id stops answering permission questions', async () => {
    const { store } = build();
    await store.put(state());

    await store.patch(GUILD, { kind: 'channel.delete', channelId: THREAD });

    expect((await store.get(GUILD))?.channels.has(THREAD)).toBe(false);
    expect((await store.get(GUILD))?.channels.has(SUPPORT)).toBe(true);
  });

  test('a member join now moves a member count that actually came back from Redis', async () => {
    const { store } = build();
    await store.put(state());

    await store.patch(GUILD, { kind: 'member.count', delta: 1 });

    expect((await store.get(GUILD))?.memberCount).toBe(43);
  });
});

describe('member count under bus redelivery', () => {
  const join: GuildStatePatch = { kind: 'member.count', delta: 1 };
  const JOIN = `member.joined:${GUILD}:100000000000000002:2026-08-14T09:00:00.000000+00:00`;
  const OTHER_JOIN = `member.joined:${GUILD}:100000000000000003:2026-08-14T09:05:00.000000+00:00`;

  test('a join delivered twice under the same event id counts once', async () => {
    const { store } = build();
    await store.put(state());

    await store.patch(GUILD, join, { dedupeKey: JOIN });
    await store.patch(GUILD, join, { dedupeKey: JOIN });

    expect((await store.get(GUILD))?.memberCount).toBe(43);
  });

  test('two different joins both count', async () => {
    const { store } = build();
    await store.put(state());

    await store.patch(GUILD, join, { dedupeKey: JOIN });
    await store.patch(GUILD, join, { dedupeKey: OTHER_JOIN });

    expect((await store.get(GUILD))?.memberCount).toBe(44);
  });

  test('a redelivery an hour later, long after the bus stopped retrying, is still skipped', async () => {
    const { redis, store } = build();
    await store.put(state());

    await store.patch(GUILD, join, { dedupeKey: JOIN });
    redis.now += 60 * 60_000;
    await store.patch(GUILD, join, { dedupeKey: JOIN });

    expect((await store.get(GUILD))?.memberCount).toBe(43);
  });

  test('a patch whose write failed releases its claim, so the retry still counts', async () => {
    const { redis, store } = build();
    await store.put(state());

    redis.failNextWrite = true;
    await expect(store.patch(GUILD, join, { dedupeKey: JOIN })).rejects.toThrow(
      'redis write timed out',
    );
    expect((await store.get(GUILD))?.memberCount).toBe(42);

    await store.patch(GUILD, join, { dedupeKey: JOIN });

    expect((await store.get(GUILD))?.memberCount).toBe(43);
  });

  test('a GUILD_CREATE re-baseline replaces the count, and a join redelivered after it does not move it', async () => {
    const { store } = build();
    await store.put(state());
    await store.patch(GUILD, join, { dedupeKey: JOIN });

    await store.put(state({ memberCount: 100 }));
    expect((await store.get(GUILD))?.memberCount).toBe(100);

    await store.patch(GUILD, join, { dedupeKey: JOIN });
    expect((await store.get(GUILD))?.memberCount).toBe(100);
  });

  test('claims lapse after a day, so Redis does not keep one key per join forever', async () => {
    const { redis, store } = build();
    await store.put(state());
    await store.patch(GUILD, join, { dedupeKey: JOIN });
    await store.patch(GUILD, join, { dedupeKey: OTHER_JOIN });

    redis.now += 25 * 60 * 60_000;
    redis.purgeExpired();

    expect([...redis.values.keys()]).toEqual([`proton:guild-state:${GUILD}`]);
  });
});

const ICON = 'a_0123456789abcdef0123456789abcdef';
const BANNER = '0123456789abcdef0123456789abcdef';
const PROFILED_AT = 1_800_000_000_000;

const PROFILE = {
  iconHash: ICON,
  bannerHash: null,
  description: 'A place for testing',
  boostCount: 14,
  boostTier: 2,
  profileAt: PROFILED_AT,
} satisfies Partial<GuildState>;

const PROFILE_KEYS = [
  'iconHash',
  'bannerHash',
  'description',
  'boostCount',
  'boostTier',
  'profileAt',
] as const;

async function storedWire(redis: FakeRedis): Promise<[string, Record<string, unknown>]> {
  const [key, stored] = [...redis.values.entries()][0] ?? [];
  if (key === undefined || stored === undefined) throw new Error('nothing was stored');
  return [key, JSON.parse(stored) as Record<string, unknown>];
}

async function loaded(store: RedisGuildStateStore, guildId = GUILD): Promise<GuildState> {
  const held = await store.get(guildId);
  if (!held) throw new Error('nothing loaded');
  return held;
}

function withoutUpdatedAt({ updatedAt: _updatedAt, ...rest }: GuildState) {
  return rest;
}

describe('the server profile in Redis', () => {
  test('survives the trip, so server placeholders do not read as unavailable after a restart', async () => {
    const { store } = build();
    await store.put(state(PROFILE));

    expect(await loaded(store)).toMatchObject(PROFILE);
  });

  test('a null survives as null, so "none set" does not turn into "never seen"', async () => {
    const { store } = build();
    await store.put(
      state({ iconHash: null, bannerHash: null, description: null, boostCount: null }),
    );

    const held = await loaded(store);
    expect(held.iconHash).toBeNull();
    expect(held.bannerHash).toBeNull();
    expect(held.description).toBeNull();
    expect(held.boostCount).toBeNull();
    expect('iconHash' in held).toBe(true);
  });

  test('a zero boost count and tier survive, since zero is a real reading', async () => {
    const { store } = build();
    await store.put(state({ boostCount: 0, boostTier: 0 }));

    expect(await loaded(store)).toMatchObject({ boostCount: 0, boostTier: 0 });
  });

  test('a snapshot stored before the profile was kept still loads, with every profile field absent', async () => {
    const { redis, store } = build();
    await store.put(state(PROFILE));

    const [key, wire] = await storedWire(redis);
    for (const field of PROFILE_KEYS) delete wire[field];
    redis.values.set(key, JSON.stringify(wire));

    const held = await loaded(store);
    for (const field of PROFILE_KEYS) expect(field in held).toBe(false);
    expect(held.name).toBe('Proton Test Guild');
    expect(held.memberCount).toBe(42);
  });

  test('a stored profile field of the wrong type is dropped rather than handed to a renderer', async () => {
    const { redis, store } = build();
    await store.put(state(PROFILE));

    const [key, wire] = await storedWire(redis);
    redis.values.set(
      key,
      JSON.stringify({
        ...wire,
        iconHash: 42,
        bannerHash: { hash: BANNER },
        description: ['A place'],
        boostCount: '14',
        boostTier: null,
        profileAt: 'soon',
      }),
    );

    const held = await loaded(store);
    for (const field of PROFILE_KEYS) expect(field in held).toBe(false);
  });

  test('a __proto__ key in a stored snapshot pollutes nothing and supplies no profile', async () => {
    const { redis, store } = build();
    await store.put(state());

    const [key] = await storedWire(redis);
    const stored = redis.values.get(key) ?? '';
    redis.values.set(
      key,
      `{"__proto__":{"polluted":true,"iconHash":"${ICON}","boostTier":3},${stored.slice(1)}`,
    );

    const held = await loaded(store);
    expect('iconHash' in held).toBe(false);
    expect(held.boostTier).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('guild.profile patches', () => {
  const profile = (
    at: number,
    fields: Extract<GuildStatePatch, { kind: 'guild.profile' }>['profile'],
  ) => ({ kind: 'guild.profile', at, profile: fields }) satisfies GuildStatePatch;

  test('apply every field a GUILD_UPDATE carried and record when it happened', async () => {
    const { store } = build();
    await store.put(state(PROFILE));

    await store.patch(
      GUILD,
      profile(PROFILED_AT + 5_000, {
        name: 'Renamed',
        iconHash: null,
        bannerHash: BANNER,
        description: null,
        boostCount: 15,
        boostTier: 3,
      }),
    );

    expect(await loaded(store)).toMatchObject({
      name: 'Renamed',
      iconHash: null,
      bannerHash: BANNER,
      description: null,
      boostCount: 15,
      boostTier: 3,
      profileAt: PROFILED_AT + 5_000,
    });
  });

  test('leave a field the payload did not carry exactly as it was', async () => {
    const { store } = build();
    await store.put(state(PROFILE));

    await store.patch(GUILD, profile(PROFILED_AT + 5_000, { name: 'Renamed', boostTier: 3 }));

    expect(await loaded(store)).toMatchObject({
      ...PROFILE,
      name: 'Renamed',
      boostTier: 3,
      profileAt: PROFILED_AT + 5_000,
    });
  });

  test('ignore a patch older than the stored profile, so a late delivery cannot roll it back', async () => {
    const { store } = build();
    await store.put(state(PROFILE));
    const before = withoutUpdatedAt(await loaded(store));

    await store.patch(GUILD, profile(PROFILED_AT - 1, { name: 'Stale', boostCount: 1 }));

    expect(withoutUpdatedAt(await loaded(store))).toEqual(before);
  });

  test('keep the newer of two patches that arrive out of order', async () => {
    const { store } = build();
    await store.put(state(PROFILE));

    await store.patch(GUILD, profile(PROFILED_AT + 20, { name: 'Newer' }));
    await store.patch(GUILD, profile(PROFILED_AT + 10, { name: 'Older' }));

    expect((await loaded(store)).name).toBe('Newer');
    expect((await loaded(store)).profileAt).toBe(PROFILED_AT + 20);
  });

  test('a redelivered patch changes nothing the first delivery did not', async () => {
    const { store } = build();
    await store.put(state(PROFILE));
    const update = profile(PROFILED_AT + 5_000, { name: 'Renamed', iconHash: null });

    await store.patch(GUILD, update);
    const once = withoutUpdatedAt(await loaded(store));
    await store.patch(GUILD, update);

    expect(withoutUpdatedAt(await loaded(store))).toEqual(once);
  });

  test('a snapshot from before profiles were kept takes the first patch, whatever its time', async () => {
    const { store } = build();
    await store.put(state());

    await store.patch(GUILD, profile(1, { name: 'Renamed', boostTier: 1 }));

    expect(await loaded(store)).toMatchObject({ name: 'Renamed', boostTier: 1, profileAt: 1 });
  });

  test('touch nothing but the profile: roles, channels, owner and member count stay', async () => {
    const { store } = build();
    await store.put(state(PROFILE));
    const before = await loaded(store);

    await store.patch(GUILD, profile(PROFILED_AT + 5_000, { name: 'Renamed' }));

    const after = await loaded(store);
    expect(after.roles).toEqual(before.roles);
    expect(after.channels).toEqual(before.channels);
    expect(after.botRoleIds).toEqual(before.botRoleIds);
    expect(after.ownerId).toBe(OWNER);
    expect(after.memberCount).toBe(42);
  });

  test('a patch for a guild with no snapshot is dropped, not written as a partial one', async () => {
    const { store } = build();

    await store.patch(GUILD, profile(PROFILED_AT, { name: 'Renamed' }));

    expect(await store.get(GUILD)).toBeNull();
  });

  test('a GUILD_CREATE re-baseline replaces the profile time, and an update older than it is ignored', async () => {
    const { store } = build();
    await store.put(state(PROFILE));
    await store.patch(GUILD, profile(PROFILED_AT + 10, { name: 'Renamed' }));

    await store.put(state({ ...PROFILE, name: 'Proton Test Guild', profileAt: PROFILED_AT + 30 }));
    await store.patch(GUILD, profile(PROFILED_AT + 20, { name: 'Late' }));

    expect((await loaded(store)).name).toBe('Proton Test Guild');
  });
});

const permissionBits = fc.bigInt({ min: 0n, max: (1n << 53n) - 1n });

const overwriteArb: fc.Arbitrary<Overwrite> = fc.record({
  id: fc.constantFrom(GUILD, ROLE),
  type: fc.constantFrom<0 | 1>(0, 1),
  allow: permissionBits,
  deny: permissionBits,
});

const roleArb: fc.Arbitrary<GuildRole> = fc
  .record({
    id: fc.constantFrom(GUILD, ROLE),
    permissions: permissionBits,
    position: fc.integer({ min: 0, max: 250 }),
    managed: fc.option(fc.boolean(), { nil: undefined }),
  })
  .map(({ managed, ...role }) => (managed === undefined ? role : { ...role, managed }));

const channelArb: fc.Arbitrary<ChannelState> = fc
  .record({
    id: fc.constantFrom(SUPPORT, THREAD),
    parentId: fc.option(fc.constantFrom(SUPPORT), { nil: null }),
    type: fc.option(fc.constantFrom(...Object.values(CHANNEL_TYPES)), { nil: undefined }),
    name: fc.option(fc.string(), { nil: undefined }),
    overwrites: fc.array(overwriteArb, { maxLength: 4 }),
  })
  .map(({ type, name, ...channel }) => ({
    ...channel,
    ...(type === undefined ? {} : { type }),
    ...(name === undefined ? {} : { name }),
  }));

const stateArb: fc.Arbitrary<GuildState> = fc
  .record({
    guildId: fc.constant(GUILD),
    ownerId: fc.constant(OWNER),
    everyoneRoleId: fc.constant(GUILD),
    roles: fc
      .array(roleArb, { maxLength: 3 })
      .map((r) => new Map(r.map((role) => [role.id, role]))),
    botRoleIds: fc.array(fc.constantFrom(GUILD, ROLE), { maxLength: 2 }),
    channels: fc
      .array(channelArb, { maxLength: 3 })
      .map((c) => new Map(c.map((channel) => [channel.id, channel]))),
    name: fc.option(fc.string(), { nil: undefined }),
    memberCount: fc.option(fc.integer({ min: 0, max: 500_000 }), { nil: undefined }),
    iconHash: fc.option(fc.option(fc.string(), { nil: null }), { nil: undefined }),
    bannerHash: fc.option(fc.option(fc.string(), { nil: null }), { nil: undefined }),
    description: fc.option(fc.option(fc.string(), { nil: null }), { nil: undefined }),
    boostCount: fc.option(fc.option(fc.integer({ min: 0, max: 1_000 }), { nil: null }), {
      nil: undefined,
    }),
    boostTier: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
    profileAt: fc.option(fc.integer({ min: 0, max: 2_000_000_000_000 }), { nil: undefined }),
    updatedAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  })
  .map(
    ({
      name,
      memberCount,
      iconHash,
      bannerHash,
      description,
      boostCount,
      boostTier,
      profileAt,
      ...rest
    }) => ({
      ...rest,
      ...(name === undefined ? {} : { name }),
      ...(memberCount === undefined ? {} : { memberCount }),
      ...(iconHash === undefined ? {} : { iconHash }),
      ...(bannerHash === undefined ? {} : { bannerHash }),
      ...(description === undefined ? {} : { description }),
      ...(boostCount === undefined ? {} : { boostCount }),
      ...(boostTier === undefined ? {} : { boostTier }),
      ...(profileAt === undefined ? {} : { profileAt }),
    }),
  );

describe('the wire format as a whole', () => {
  test('gives back exactly the state it was handed, field for field', async () => {
    await fc.assert(
      fc.asyncProperty(stateArb, async (original) => {
        const { store } = build();
        await store.put(original);

        expect(await store.get(GUILD)).toEqual(original);
      }),
      { numRuns: 200 },
    );
  });
});
