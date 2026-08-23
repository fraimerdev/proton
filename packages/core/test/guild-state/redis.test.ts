import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { Redis } from 'ioredis';
import { CHANNEL_TYPES, isThreadChannel } from '../../src/guild-state/channel-types.ts';
import { RedisGuildStateStore } from '../../src/guild-state/redis.ts';
import type { ChannelState, GuildState } from '../../src/guild-state/types.ts';
import { Permissions } from '../../src/permissions/bits.ts';
import type { GuildRole, Overwrite } from '../../src/permissions/compute.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const ROLE = '410000000000000005';
const SUPPORT = '500000000000000001';
const THREAD = '600000000000000001';

class FakeRedis {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ..._rest: unknown[]): Promise<'OK'> {
    this.values.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
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
      [SUPPORT, { id: SUPPORT, parentId: null, type: CHANNEL_TYPES.guildText, overwrites: [] }],
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
    overwrites: fc.array(overwriteArb, { maxLength: 4 }),
  })
  .map(({ type, ...channel }) => (type === undefined ? channel : { ...channel, type }));

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
    updatedAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  })
  .map(({ name, memberCount, ...rest }) => ({
    ...rest,
    ...(name === undefined ? {} : { name }),
    ...(memberCount === undefined ? {} : { memberCount }),
  }));

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
