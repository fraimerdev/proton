import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Causation } from '@proton/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '../src/client.ts';
import { DrizzleMemberXpStore, type MemberXpGrantInput } from '../src/member-xp-store.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds, members } from '../src/schema/index.ts';
import { firstRow, rows } from './helpers.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleMemberXpStore;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const MEMBER = '400000000000000001';

const MAX_XP = 5_000;
const levelForXp = (xp: number): number => Math.min(50, Math.floor(Math.max(0, xp) / 100));

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const LAST_MESSAGE = new Date(NOW - 60_000);

const CAUSATION: Causation = {
  kind: 'achievement',
  rootId: 'message.created:900000000000000001:500000000000000001',
  depth: 1,
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleMemberXpStore(handle, { levelForXp, maxXp: MAX_XP });
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from xp_grants`;
  await handle.client`delete from member_activity_daily`;
  await handle.client`delete from members`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
});

function grant(overrides: Partial<MemberXpGrantInput> = {}): MemberXpGrantInput {
  return {
    guildId: GUILD,
    userId: MEMBER,
    amount: 250,
    grantId: 'achievements:900000000000000001:400000000000000001:chatterbox:gold:0',
    sourceModule: 'achievements',
    causation: CAUSATION,
    now: NOW,
    ...overrides,
  };
}

async function seedMember(xp: number): Promise<void> {
  await handle.db.insert(members).values({
    guildId: GUILD,
    userId: MEMBER,
    xp,
    level: levelForXp(xp),
    lastXpAt: LAST_MESSAGE,
    messageCount: 12,
    voiceSeconds: 600,
  });
}

interface MemberRow {
  xp: number;
  level: number;
  last_xp_at: string | null;
  message_count: number;
  voice_seconds: number;
}

async function member(guildId = GUILD): Promise<MemberRow> {
  return await firstRow<MemberRow>(handle.client`
    select xp, level, last_xp_at, message_count, voice_seconds
      from members where guild_id = ${guildId} and user_id = ${MEMBER}
  `);
}

async function ledgerCount(): Promise<number> {
  return (await firstRow<{ n: number }>(handle.client`select count(*)::int as n from xp_grants`)).n;
}

describe('DrizzleMemberXpStore.grant', () => {
  test('a member with no row yet is created with the granted XP and the ledger records it', async () => {
    expect(await store.grant(grant())).toEqual({
      xp: 250,
      level: 2,
      previousLevel: 0,
      awarded: true,
      duplicate: false,
    });

    expect(await member()).toMatchObject({ xp: 250, level: 2, message_count: 0, voice_seconds: 0 });

    const stored = await firstRow<{
      user_id: string;
      amount: number;
      source_module: string;
      causation: Causation;
      previous_level: number;
      level: number;
      xp_after: number;
      created_at: string;
    }>(handle.client`select * from xp_grants where guild_id = ${GUILD}`);

    expect(stored).toMatchObject({
      user_id: MEMBER,
      amount: 250,
      source_module: 'achievements',
      causation: CAUSATION,
      previous_level: 0,
      level: 2,
      xp_after: 250,
    });
    expect(new Date(stored.created_at).getTime()).toBe(NOW);
  });

  test('a grant adds to what the member already has and reports the level it crossed', async () => {
    await seedMember(150);

    expect(await store.grant(grant({ amount: 100 }))).toMatchObject({
      xp: 250,
      level: 2,
      previousLevel: 1,
      awarded: true,
    });
    expect((await member()).level).toBe(2);
  });

  test('a replay credits nothing and answers with the values stored the first time', async () => {
    await seedMember(150);

    const first = await store.grant(grant({ amount: 100 }));
    await handle.client`update members set xp = 900 where guild_id = ${GUILD}`;

    const replay = await store.grant(grant({ amount: 100 }));

    expect(replay).toEqual({ ...first, awarded: false, duplicate: true });
    expect((await member()).xp).toBe(900);
    expect(await ledgerCount()).toBe(1);
  });

  test('two deliveries of one grant racing each other credit it once', async () => {
    await seedMember(0);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.grant(grant({ amount: 300 }))),
    );

    expect((await member()).xp).toBe(300);
    expect(await ledgerCount()).toBe(1);
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    for (const result of results) {
      expect(result).toMatchObject({ xp: 300, level: 3, previousLevel: 0 });
    }
  });

  test('the total stops at the ceiling and the ledger says where it stopped', async () => {
    await seedMember(4_950);

    expect(await store.grant(grant({ amount: 200 }))).toMatchObject({
      xp: MAX_XP,
      level: 50,
      previousLevel: 49,
      awarded: true,
    });
    expect((await member()).xp).toBe(MAX_XP);
  });

  test('a member already at the ceiling gains nothing and no level', async () => {
    await seedMember(MAX_XP);

    expect(await store.grant(grant({ amount: 200 }))).toMatchObject({
      xp: MAX_XP,
      level: 50,
      previousLevel: 50,
      awarded: true,
    });
  });

  test('a grant is not activity: the cooldown, counters and daily buckets are untouched', async () => {
    await seedMember(150);

    await store.grant(grant());

    const after = await member();
    expect(after.last_xp_at === null ? null : new Date(after.last_xp_at).getTime()).toBe(
      LAST_MESSAGE.getTime(),
    );
    expect(after.message_count).toBe(12);
    expect(after.voice_seconds).toBe(600);

    const buckets = await rows<{ n: number }>(
      handle.client`select count(*)::int as n from member_activity_daily`,
    );
    expect(buckets[0]?.n).toBe(0);
  });

  test('the same grant id in another server is another grant', async () => {
    await store.grant(grant());
    const other = await store.grant(grant({ guildId: OTHER_GUILD }));

    expect(other).toMatchObject({ awarded: true, duplicate: false, xp: 250 });
    expect((await member(OTHER_GUILD)).xp).toBe(250);
    expect(await ledgerCount()).toBe(2);
  });

  test('a server leaving takes its grants with it', async () => {
    await store.grant(grant());
    await store.grant(grant({ guildId: OTHER_GUILD }));

    await handle.client`delete from guilds where id = ${GUILD}`;

    const left = await rows<{ guild_id: string }>(handle.client`select guild_id from xp_grants`);
    expect(left.map((row) => row.guild_id)).toEqual([OTHER_GUILD]);
  });
});
