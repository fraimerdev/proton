import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb, type DbHandle, guildModules, guilds, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MODULE_ID } from '../src/config.ts';
import { DrizzleAchievementStore } from '../src/postgres-store.ts';
import { requirementValue } from '../src/store.ts';
import {
  ACHIEVEMENT,
  activity,
  audit,
  DAY,
  describeAchievementStore,
  GUILD,
  HOUR,
  MINUTE,
  OTHER_GUILD,
  plan,
  T0,
  target,
  USER,
  USER_2,
  unlockInput,
} from './contracts.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleAchievementStore;

const TABLES = [
  'achievement_seen',
  'achievement_activity',
  'achievement_progress',
  'achievement_members',
  'achievement_state',
  'achievement_periods',
  'achievement_unlocks',
  'achievement_rewards',
  'achievement_member_facts',
  'achievement_badges',
] as const;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleAchievementStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

async function reset(): Promise<void> {
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
}

async function setModule(guildId: string, enabled: boolean, config: unknown): Promise<void> {
  await handle.db
    .insert(guildModules)
    .values({ guildId, moduleId: MODULE_ID, enabled, config })
    .onConflictDoUpdate({
      target: [guildModules.guildId, guildModules.moduleId],
      set: { enabled, config },
    });
}

async function rowsFor(guildId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  for (const table of TABLES) {
    const [row] = await handle.client.unsafe<{ n: number }[]>(
      `select count(*)::int as n from ${table} where guild_id = $1`,
      [guildId],
    );
    counts[table] = row?.n ?? 0;
  }

  return counts;
}

async function waitForLockWait(): Promise<void> {
  for (let tries = 0; tries < 100; tries += 1) {
    const [row] = await handle.client<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`;
    if ((row?.n ?? 0) > 0) return;
    await Bun.sleep(50);
  }

  throw new Error('no query ever waited on a lock, so the fence under test was never exercised');
}

describeAchievementStore('postgres store', async () => {
  await reset();
  return { store, setModule };
});

describe('postgres store: concurrency and lifecycle', () => {
  test('an unlock waiting behind a reset’s row lock comes back stale and creates nothing', async () => {
    await reset();
    await store.unlock(unlockInput({ tiers: [] }));

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const resetting = handle.client.begin(async (sql) => {
      await sql`
        update achievement_members set generation = generation + 1
         where guild_id = ${GUILD} and achievement_id = ${ACHIEVEMENT} and user_id = ${USER}`;
      locked();
      await gate;
    });

    await held;
    const unlocking = store.unlock(unlockInput());
    await waitForLockWait();
    release();
    await resetting;

    expect(await unlocking).toEqual({ stale: true, unlocks: [], rewards: [] });
    const [row] = await handle.client<{ n: number }[]>`
      select count(*)::int as n from achievement_unlocks where guild_id = ${GUILD}`;
    expect(row?.n).toBe(0);
  });

  test('a rebuild slice running beside live records loses no increment', async () => {
    await reset();

    let key = 0;
    const burst = (count: number) =>
      Promise.all(
        Array.from({ length: count }, () => {
          key += 1;
          return store.record(
            activity({ sourceKey: `burst-${key}`, occurredAt: T0 + (key % 5) * HOUR + MINUTE }),
            [target()],
            [ACHIEVEMENT],
          );
        }),
      );

    await burst(10);

    for (let round = 0; round < 5; round += 1) {
      await Promise.all([store.rebuildSlice(GUILD, plan(), null, 'write'), burst(10)]);
    }

    const [state] = await store.memberStates(GUILD, USER, [ACHIEVEMENT]);
    expect(state && requirementValue(state, 'messages', 1)).toBe(60);

    const [bucketed] = await handle.client<{ total: number }[]>`
      select sum(amount_sum)::int as total from achievement_activity where guild_id = ${GUILD}`;
    expect(bucketed?.total).toBe(60);
  });

  test('deleting a server removes every achievement row it owns and nothing of another', async () => {
    await reset();

    for (const guildId of [GUILD, OTHER_GUILD]) {
      await setModule(guildId, true, { enabled: true, achievements: [] });
      await store.syncPeriods(guildId, T0);
      await store.record(
        activity({ guildId, sourceKey: `seed-${guildId}` }),
        [target()],
        [ACHIEVEMENT],
      );
      await store.unlock(
        unlockInput({ guildId, rewards: [{ kind: 'xp', amount: 10 }], group: guildId }),
      );
      await store.upsertFacts(guildId, USER, { joinedAt: T0 });
      await store.putBadge(guildId, {
        assetId: 'abcd1234',
        contentType: 'image/png',
        base64: 'AA==',
        byteSize: 1,
        uploadedBy: USER,
        uploadedAt: T0,
      });
    }

    const before = await rowsFor(GUILD);
    expect(Object.entries(before).filter(([, n]) => n === 0)).toEqual([]);
    const other = await rowsFor(OTHER_GUILD);

    await handle.client`delete from guilds where id = ${GUILD}`;

    expect(Object.values(await rowsFor(GUILD)).every((n) => n === 0)).toBe(true);
    expect(await rowsFor(OTHER_GUILD)).toEqual(other);
  });

  test('a join date nobody has touched for a year survives, a join-less row does not', async () => {
    await reset();
    await store.upsertFacts(GUILD, USER, { joinedAt: T0 });
    await store.upsertFacts(GUILD, USER_2, { premiumSince: T0 });
    await handle.client`
      update achievement_member_facts set updated_at = now() - interval '400 days'
       where guild_id = ${GUILD}`;

    expect((await store.purge(Date.now())).facts).toBe(1);
    expect(await store.facts(GUILD, USER)).not.toBeNull();
    expect(await store.facts(GUILD, USER_2)).toBeNull();
  });

  test('timestamps round-trip at millisecond precision', async () => {
    await reset();
    const at = T0 + 123;

    await store.upsertFacts(GUILD, USER, { joinedAt: at, premiumSince: at + 1 });
    expect(await store.facts(GUILD, USER)).toMatchObject({ joinedAt: at, premiumSince: at + 1 });

    const { unlocks } = await store.unlock(unlockInput({ unlockedAt: at + 2 }));
    expect(unlocks[0]?.unlockedAt).toBe(at + 2);

    await store.resetMember({
      guildId: GUILD,
      achievementIds: [ACHIEVEMENT],
      userId: USER,
      allowRewardsAgain: false,
      actorId: USER,
      at: at + 3,
      audit: audit('reset-precision'),
    });
    const [state] = await store.memberStates(GUILD, USER, [ACHIEVEMENT]);
    expect(state?.countedFrom).toBe(at + 3);
    expect((await store.memberDetail(GUILD, USER)).voided[0]?.voidedAt).toBe(at + 3);
  });

  test('a reset writes its audit row in the same transaction', async () => {
    await reset();

    await store.resetAchievement({
      guildId: GUILD,
      achievementId: ACHIEVEMENT,
      allowRewardsAgain: false,
      actorId: USER,
      at: T0 + DAY,
      audit: audit('reset-audited'),
    });

    const [row] = await handle.client<{ action: string; after: unknown }[]>`
      select action, after from audit_trail where id = 'reset-audited'`;
    expect(row).toEqual({ action: 'module.achievements.reset', after: { reset: 'reset-audited' } });
  });
});
