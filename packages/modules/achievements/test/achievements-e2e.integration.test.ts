import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisDedupeStore } from '@proton/core';
import { createDb, type DbHandle, guildModules, guilds, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { type AchievementInput, type AnnouncementMessage, MODULE_ID } from '../src/config.ts';
import { DrizzleAchievementStore } from '../src/postgres-store.ts';
import { instantiatePreset } from '../src/presets.ts';
import { RedisFencedLocks, RedisLimits } from '../src/redis-helpers.ts';
import { RedisAchievementVoiceStore } from '../src/voice-store.ts';
import {
  GUILD,
  type Harness,
  harnessOver,
  MEMBER,
  MINUTE,
  OTHER,
  OTHER_GUILD,
  REWARD_ROLE,
  SECOND,
  seededRandom,
  TEXT,
  VOICE,
} from './harness.ts';

let postgres: StartedPostgreSqlContainer;
let cache: StartedRedisContainer;
let handle: DbHandle;
let redis: Redis;

beforeAll(async () => {
  [postgres, cache] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  handle = createDb(postgres.getConnectionUri());
  await runMigrations(handle);
  redis = new Redis(cache.getConnectionUrl());
}, 240_000);

afterAll(async () => {
  redis?.disconnect();
  await handle?.close();
  await Promise.all([postgres?.stop(), cache?.stop()]);
}, 240_000);

const REWARD_MESSAGE: AnnouncementMessage = {
  content: '{user.mention} earned **{achievement.name}**: {rewards.summary}',
  embeds: [],
  components: [],
  mentions: { everyone: false, roles: false, users: true },
  v2: [],
};

const FIRST_WORDS: AchievementInput = {
  id: 'first-words',
  name: 'First Words',
  kind: 'single',
  status: 'active',
  requirements: [{ id: 'goal', trigger: 'messages.sent' }],
  tiers: [
    { id: 'single', targets: { goal: 1 }, rewards: [{ kind: 'add_role', roleId: REWARD_ROLE }] },
  ],
};

async function containers(): Promise<Harness<DrizzleAchievementStore>> {
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
  await redis.flushall();

  return harnessOver({
    store: new DrizzleAchievementStore(handle),
    clock: { now: Math.floor(Date.now() / SECOND) * SECOND },
    voice: new RedisAchievementVoiceStore(redis),
    locks: new RedisFencedLocks(redis),
    limits: new RedisLimits(redis),
    dedupe: new RedisDedupeStore(redis),
    setModule: async (guildId, enabled, config) => {
      await handle.db
        .insert(guildModules)
        .values({ guildId, moduleId: MODULE_ID, enabled, config })
        .onConflictDoUpdate({
          target: [guildModules.guildId, guildModules.moduleId],
          set: { enabled, config },
        });
    },
  });
}

describe('achievements over Postgres, Redis and the real executor', () => {
  test('the All-Rounder demo end to end', async () => {
    const h = await containers();
    const allRounder: AchievementInput = {
      ...instantiatePreset('all_rounder', { random: seededRandom(7), roleId: REWARD_ROLE }),
      status: 'active',
    };
    await h.configure({ announcement: { message: REWARD_MESSAGE }, achievements: [allRounder] });
    const [messages = '', minutes = '', level = ''] = allRounder.requirements.map(({ id }) => id);

    for (let index = 0; index < 100; index++) {
      await h.tick(SECOND);
      await h.emit(h.message());
    }

    await h.emit(h.voiceUpdate({ channelId: VOICE }));
    await h.tick(60 * MINUTE, 10 * MINUTE);
    await h.emit(h.voiceUpdate({ channelId: null }));

    expect([
      await h.value(MEMBER, allRounder.id, messages),
      await h.value(MEMBER, allRounder.id, minutes),
    ]).toEqual([100, 60]);
    expect(await h.voice.list(GUILD)).toEqual([]);
    expect(await h.unlocks(MEMBER)).toEqual([]);

    await h.gainXp(MEMBER, 500, TEXT);

    expect(await h.unlocks(MEMBER)).toMatchObject([
      {
        achievementId: allRounder.id,
        tierId: 'single',
        originChannelId: TEXT,
        progress: { [messages]: 100, [minutes]: 60, [level]: 5 },
        announceStatus: 'sent',
      },
    ]);
    expect(await h.rewards(MEMBER, allRounder.id)).toMatchObject([
      { rewardKey: `add_role:${REWARD_ROLE}`, status: 'delivered' },
      { rewardKey: 'xp', amount: 250, status: 'delivered' },
    ]);
    expect(h.roleCalls()).toEqual([
      { method: 'PUT', guildId: GUILD, userId: MEMBER, roleId: REWARD_ROLE, status: 204 },
    ]);
    expect(h.leveling.xpOf(GUILD, MEMBER)).toBe(750);
    expect(h.ofType('achievements.unlocked')).toHaveLength(1);
    expect(h.sends(TEXT).map(({ body }) => body.content)).toEqual([
      `<@${MEMBER}> earned **All-Rounder**: <@&${REWARD_ROLE}> and 250 XP given`,
    ]);
  });

  test('duplicate delivery counts once, unlocks once and gives each reward once', async () => {
    const h = await containers();
    await h.configure({
      achievements: [
        {
          id: 'chatterbox',
          name: 'Chatterbox',
          kind: 'tiered',
          status: 'active',
          requirements: [{ id: 'goal', trigger: 'messages.sent' }],
          tiers: [
            {
              id: 'bronze',
              targets: { goal: 3 },
              rewards: [{ kind: 'add_role', roleId: REWARD_ROLE }],
            },
            { id: 'silver', targets: { goal: 5 }, rewards: [{ kind: 'xp', amount: 50 }] },
          ],
        },
      ],
    });

    for (let index = 0; index < 5; index++) {
      h.advance(SECOND);
      const message = h.message();
      await Promise.all([h.emit(message), h.emit(message, { worker: 'second' })]);
      await h.emit(message);
    }
    await h.redeliver('achievements.unlocked');
    await h.redeliver('xp.grant_requested');
    await h.redeliver('xp.granted');

    expect(await h.value(MEMBER, 'chatterbox', 'goal')).toBe(5);
    expect((await h.unlocks(MEMBER)).map(({ tierId }) => tierId)).toEqual(['bronze', 'silver']);
    expect(h.ofType('achievements.unlocked')).toHaveLength(2);
    expect(h.roleCalls()).toEqual([
      { method: 'PUT', guildId: GUILD, userId: MEMBER, roleId: REWARD_ROLE, status: 204 },
    ]);
    expect(h.leveling.xpOf(GUILD, MEMBER)).toBe(50);
    expect((await h.rewards(MEMBER, 'chatterbox')).map(({ status }) => status)).toEqual([
      'delivered',
      'delivered',
    ]);
    expect(h.sends(TEXT)).toHaveLength(2);
  });

  test('a crash after recording recovers on redelivery, and one after unlocking through the sweep', async () => {
    const h = await containers();
    await h.configure({ achievements: [FIRST_WORDS] });

    h.crashAfter('record');
    const first = h.message();
    await expect(h.emit(first)).rejects.toThrow('the worker died right after record');
    expect(await h.value(MEMBER, 'first-words', 'goal')).toBe(1);
    expect(await h.unlocks(MEMBER)).toEqual([]);

    await h.emit(first);
    await h.emit(first);

    expect(await h.value(MEMBER, 'first-words', 'goal')).toBe(1);
    expect(await h.unlocks(MEMBER)).toMatchObject([{ announceStatus: 'sent' }]);
    expect(h.roleCalls()).toHaveLength(1);

    h.crashAfter('unlock');
    const second = h.message({ authorId: OTHER });
    await expect(h.emit(second)).rejects.toThrow('the worker died right after unlock');
    await h.emit(second);

    expect(await h.unlocks(OTHER)).toMatchObject([
      { publishedAt: null, announceStatus: 'pending' },
    ]);
    expect(h.ofType('achievements.unlocked')).toHaveLength(1);

    await h.tick(3 * MINUTE, 30 * SECOND);

    expect(await h.unlocks(OTHER)).toMatchObject([{ announceStatus: 'sent' }]);
    expect(await h.rewards(OTHER, 'first-words')).toMatchObject([{ status: 'delivered' }]);
    expect(h.ofType('achievements.unlocked')).toHaveLength(2);
    expect(h.roleCalls().map(({ userId }) => userId)).toEqual([MEMBER, OTHER]);
    expect(h.sends(TEXT)).toHaveLength(2);
  });
});
