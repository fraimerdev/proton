import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { buildGuildState } from '../../src/guild-state/build.ts';
import { RedisGuildStateStore } from '../../src/guild-state/redis.ts';
import type { GuildState } from '../../src/guild-state/types.ts';
import { Permissions } from '../../src/permissions/bits.ts';

let container: StartedRedisContainer;
let redis: Redis;
let store: RedisGuildStateStore;

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const ROLE = '410000000000000005';
const CHANNEL = '500000000000000001';

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
  store = new RedisGuildStateStore(redis);
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
});

function state(): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, { id: GUILD, permissions: Permissions.ViewChannel, position: 0 }],
      [
        ROLE,
        { id: ROLE, permissions: Permissions.BanMembers | Permissions.BypassSlowmode, position: 5 },
      ],
    ]),
    botRoleIds: [ROLE],
    channels: new Map([
      [
        CHANNEL,
        {
          id: CHANNEL,
          parentId: null,
          overwrites: [
            { id: GUILD, type: 0, allow: Permissions.SendMessages, deny: Permissions.PinMessages },
          ],
        },
      ],
    ]),
    updatedAt: 1_800_000_000_000,
  };
}

describe('RedisGuildStateStore', () => {
  test('round-trips a full snapshot', async () => {
    await store.put(state());
    const loaded = await store.get(GUILD);

    expect(loaded?.ownerId).toBe(OWNER);
    expect(loaded?.botRoleIds).toEqual([ROLE]);
    expect(loaded?.roles.size).toBe(2);
    expect(loaded?.channels.get(CHANNEL)?.overwrites).toHaveLength(1);
  });

  /**
   * The serialization hazard. `JSON.stringify` throws outright on a bigint, and
   * the obvious "fix" — Number(...) — silently truncates every permission bit
   * above 2^53, which since the 2026 splits includes PIN_MESSAGES and
   * BYPASS_SLOWMODE. Permissions therefore cross the wire as strings.
   */
  test('permission bigints survive the round trip exactly', async () => {
    await store.put(state());
    const loaded = await store.get(GUILD);

    expect(loaded?.roles.get(ROLE)?.permissions).toBe(
      Permissions.BanMembers | Permissions.BypassSlowmode,
    );
    expect(typeof loaded?.roles.get(ROLE)?.permissions).toBe('bigint');

    const overwrite = loaded?.channels.get(CHANNEL)?.overwrites[0];
    expect(overwrite?.allow).toBe(Permissions.SendMessages);
    expect(overwrite?.deny).toBe(Permissions.PinMessages);
  });

  test('role positions survive, since hierarchy depends on them', async () => {
    await store.put(state());
    const loaded = await store.get(GUILD);

    expect(loaded?.roles.get(ROLE)?.position).toBe(5);
  });

  test('an unknown guild is null, not an empty snapshot', async () => {
    // An empty snapshot would let prechecks compute confidently wrong answers.
    expect(await store.get('111111111111111111')).toBeNull();
  });

  test('corrupt stored state degrades to null', async () => {
    await redis.set('proton:guild-state:999', 'not json');

    expect(await store.get('999')).toBeNull();
  });

  describe('incremental patches', () => {
    beforeEach(async () => {
      await store.put(state());
    });

    test('upserts and deletes a role', async () => {
      const added = { id: '410000000000000099', permissions: 0n, position: 7 };
      await store.patch(GUILD, { kind: 'role.upsert', role: added });
      expect((await store.get(GUILD))?.roles.get(added.id)?.position).toBe(7);

      await store.patch(GUILD, { kind: 'role.delete', roleId: added.id });
      expect((await store.get(GUILD))?.roles.has(added.id)).toBe(false);
    });

    test('updates the bot’s own roles', async () => {
      await store.patch(GUILD, { kind: 'bot.roles', roleIds: [GUILD, ROLE] });

      expect((await store.get(GUILD))?.botRoleIds).toEqual([GUILD, ROLE]);
    });

    test('a patch for an unknown guild is dropped, not half-applied', async () => {
      await store.patch('111111111111111111', {
        kind: 'role.upsert',
        role: { id: 'x', permissions: 0n, position: 1 },
      });

      // Creating a partial snapshot here — one role, no owner — would let the
      // prechecks believe they had real state.
      expect(await store.get('111111111111111111')).toBeNull();
    });
  });

  test('state built from a GUILD_CREATE payload persists intact', async () => {
    const built = buildGuildState(
      {
        id: GUILD,
        owner_id: OWNER,
        roles: [{ id: ROLE, permissions: String(Permissions.BanMembers), position: 5 }],
        channels: [{ id: CHANNEL, parent_id: null, permission_overwrites: [] }],
        members: [{ user: { id: BOT }, roles: [ROLE] }],
      },
      BOT,
    );

    expect(built).not.toBeNull();
    if (!built) return;

    await store.put(built);
    const loaded = await store.get(GUILD);

    expect(loaded?.botRoleIds).toEqual([ROLE]);
    expect(loaded?.roles.get(ROLE)?.permissions).toBe(Permissions.BanMembers);
  });
});
