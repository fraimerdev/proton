import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DbHandle, guilds, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { DrizzleGiveawayStore } from '../src/postgres-store.ts';
import type { MemberSnapshot, NewEntry, Reweigh } from '../src/store.ts';
import { giveawayEntries, giveaways } from '../src/table.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleGiveawayStore;

const GUILD = '900000000000000001';
const HOST = '100000000000000001';
const MEMBER = '100000000000000002';
const OTHER = '100000000000000003';
const ROLE_A = '600000000000000001';
const ROLE_B = '600000000000000002';
const GIVEAWAY = 'g-reentry';
const NOW = new Date('2026-09-18T12:00:00.000Z');

function at(second: number): Date {
  return new Date(NOW.getTime() + second * 1_000);
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleGiveawayStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from giveaway_bonus_entries`;
  await handle.client`delete from giveaway_entries`;
  await handle.client`delete from giveaways`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });

  await store.create({
    id: GIVEAWAY,
    guildId: GUILD,
    channelId: '500000000000000001',
    messageId: '700000000000000001',
    hostId: HOST,
    title: 'A prize',
    winnerCount: 1,
    endsAt: new Date(Date.now() + 3_600_000),
    createdBy: HOST,
  });
});

function snapshot(roleIds: string[]): MemberSnapshot {
  return { roleIds, joinedAt: null, premiumSince: null, hasAvatar: true };
}

function entryFor(userId: string, pressedAt: Date, over: Partial<NewEntry> = {}): NewEntry {
  return {
    giveawayId: GIVEAWAY,
    userId,
    baseEntries: 1,
    totalEntries: 1,
    breakdown: [],
    memberSnapshot: snapshot([ROLE_A]),
    pressedAt,
    ...over,
  };
}

function rowFilter(userId: string) {
  return and(eq(giveawayEntries.giveawayId, GIVEAWAY), eq(giveawayEntries.userId, userId));
}

async function rowsOf(userId: string) {
  return handle.db.select().from(giveawayEntries).where(rowFilter(userId));
}

async function rowOf(userId: string) {
  const [row] = await rowsOf(userId);
  if (!row) throw new Error(`no entry row for ${userId}`);
  return row;
}

async function giveawayRow() {
  const [row] = await handle.db.select().from(giveaways).where(eq(giveaways.id, GIVEAWAY));
  if (!row) throw new Error(`no giveaway row for ${GIVEAWAY}`);
  return row;
}

async function pool(): Promise<string[]> {
  const ids: string[] = [];
  for await (const chunk of store.entrants(GIVEAWAY, 10)) {
    ids.push(...chunk.map((row) => row.userId));
  }

  return ids;
}

describe('re-entering after Leave', () => {
  test('a member who left is entered again and counted again', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.enter(entryFor(OTHER, at(0)));

    expect(await store.leave(GIVEAWAY, MEMBER, at(1))).toBe('left');
    expect(await store.entrantCount(GIVEAWAY)).toBe(1);
    expect(await store.entry(GIVEAWAY, MEMBER)).toBeNull();

    expect(await store.enter(entryFor(MEMBER, at(2)))).toBe('entered');

    expect(await store.entrantCount(GIVEAWAY)).toBe(2);
    expect((await store.entry(GIVEAWAY, MEMBER))?.userId).toBe(MEMBER);
    expect(await pool()).toEqual([MEMBER, OTHER]);
  });

  test('a first entry is stamped with its press time, however late it is handled', async () => {
    expect(await store.enter(entryFor(MEMBER, at(-30)))).toBe('entered');
    expect((await rowOf(MEMBER)).joinedAt).toEqual(at(-30));
  });

  test('re-entering takes the new weight and snapshot and stamps the new press', async () => {
    await store.enter(entryFor(MEMBER, at(0), { totalEntries: 3 }));
    await store.leave(GIVEAWAY, MEMBER, at(1));
    await handle.db
      .update(giveawayEntries)
      .set({ revalidatedAt: at(1) })
      .where(rowFilter(MEMBER));

    expect(
      await store.enter(
        entryFor(MEMBER, at(2), {
          baseEntries: 2,
          totalEntries: 5,
          memberSnapshot: snapshot([ROLE_B]),
        }),
      ),
    ).toBe('entered');

    const row = await rowOf(MEMBER);
    expect(row.leftAt).toBeNull();
    expect(row.revalidatedAt).toBeNull();
    expect(row.baseEntries).toBe(2);
    expect(row.totalEntries).toBe(5);
    expect((row.memberSnapshot as MemberSnapshot | null)?.roleIds).toEqual([ROLE_B]);
    expect(row.joinedAt).toEqual(at(2));
  });

  test('leaving and coming back keeps the one history row that loss streaks count', async () => {
    await store.enter(entryFor(MEMBER, at(0)));

    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect(await store.leave(GIVEAWAY, MEMBER, at(2 * cycle + 1))).toBe('left');
      expect((await store.priorEntryCounts(GUILD, [MEMBER], new Date(0))).get(MEMBER)).toBe(1);
      expect(await store.enter(entryFor(MEMBER, at(2 * cycle + 2)))).toBe('entered');
    }

    expect(await rowsOf(MEMBER)).toHaveLength(1);
    expect((await store.priorEntryCounts(GUILD, [MEMBER], new Date(0))).get(MEMBER)).toBe(1);
  });

  test('a member still in is already entered, and their row is left alone', async () => {
    await store.enter(entryFor(MEMBER, at(0), { totalEntries: 4 }));

    expect(await store.enter(entryFor(MEMBER, at(1), { totalEntries: 9 }))).toBe('already-entered');

    const row = await rowOf(MEMBER);
    expect(row.totalEntries).toBe(4);
    expect(row.joinedAt).toEqual(at(0));
  });

  test('two presses racing after a leave enter the member exactly once', async () => {
    await store.enter(entryFor(MEMBER, at(0)));

    for (let round = 0; round < 10; round += 1) {
      expect(await store.leave(GIVEAWAY, MEMBER, at(3 * round + 1))).toBe('left');

      const outcomes = await Promise.all([
        store.enter(entryFor(MEMBER, at(3 * round + 2))),
        store.enter(entryFor(MEMBER, at(3 * round + 2.5))),
      ]);

      expect(outcomes.sort()).toEqual(['already-entered', 'entered']);
      expect(await store.entrantCount(GIVEAWAY)).toBe(1);
    }
  });

  test('two first presses racing still enter the member exactly once', async () => {
    const outcomes = await Promise.all([
      store.enter(entryFor(MEMBER, at(0))),
      store.enter(entryFor(MEMBER, at(0.5))),
    ]);

    expect(outcomes.sort()).toEqual(['already-entered', 'entered']);
    expect(await rowsOf(MEMBER)).toHaveLength(1);
  });

  test('a leaver cannot come back once the giveaway stops running', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(1));
    await store.pause(GUILD, GIVEAWAY, HOST, null, at(2));

    expect(await store.enter(entryFor(MEMBER, at(3)))).toBe('closed');

    expect((await rowOf(MEMBER)).leftAt).toEqual(at(1));
    expect(await store.entrantCount(GIVEAWAY)).toBe(0);
  });

  test('re-entering never lifts a disqualification', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.disqualify(GIVEAWAY, [{ userId: MEMBER, reason: 'lost the role' }], at(1));

    expect(await store.enter(entryFor(MEMBER, at(2)))).not.toBe('entered');

    await handle.db
      .update(giveawayEntries)
      .set({ leftAt: at(3) })
      .where(rowFilter(MEMBER));

    expect(await store.enter(entryFor(MEMBER, at(4)))).not.toBe('entered');

    expect((await rowOf(MEMBER)).disqualifiedAt).not.toBeNull();
    expect(await store.entrantCount(GIVEAWAY)).toBe(0);
  });

  test('a bonus granted while the member was out is carried by the fresh total', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(1));
    await store.grantBonus({
      id: 'bonus-1',
      giveawayId: GIVEAWAY,
      userId: MEMBER,
      amount: 4,
      reason: null,
      grantedBy: HOST,
    });

    const bonus = await store.bonusFor(GIVEAWAY, MEMBER);
    expect(await store.enter(entryFor(MEMBER, at(2), { totalEntries: 1 + bonus }))).toBe('entered');

    expect((await store.entry(GIVEAWAY, MEMBER))?.totalEntries).toBe(5);
  });
});

describe('a replayed press is ordered by when it was pressed', () => {
  test('an Enter pressed before a Leave and redelivered after it leaves the member out', async () => {
    const first = entryFor(MEMBER, at(0));

    expect(await store.enter(first)).toBe('entered');
    expect(await store.leave(GIVEAWAY, MEMBER, at(1))).toBe('left');

    expect(await store.enter(first)).toBe('superseded');

    const row = await rowOf(MEMBER);
    expect(row.leftAt).toEqual(at(1));
    expect(row.joinedAt).toEqual(at(0));
    expect(await store.entrantCount(GIVEAWAY)).toBe(0);
  });

  test('a re-entry redelivered after a later Leave does not undo that Leave', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(1));
    const back = entryFor(MEMBER, at(2));
    expect(await store.enter(back)).toBe('entered');
    expect(await store.leave(GIVEAWAY, MEMBER, at(3))).toBe('left');

    expect(await store.enter(back)).toBe('superseded');

    expect((await rowOf(MEMBER)).leftAt).toEqual(at(3));
    expect(await store.entrantCount(GIVEAWAY)).toBe(0);
  });

  test('a Leave pressed before a re-entry and redelivered after it keeps the member in', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    expect(await store.leave(GIVEAWAY, MEMBER, at(1))).toBe('left');
    expect(await store.enter(entryFor(MEMBER, at(2)))).toBe('entered');

    expect(await store.leave(GIVEAWAY, MEMBER, at(1))).toBe('superseded');

    const row = await rowOf(MEMBER);
    expect(row.leftAt).toBeNull();
    expect(row.joinedAt).toEqual(at(2));
    expect(await store.entrantCount(GIVEAWAY)).toBe(1);
  });

  test('leave, enter and leave again in press order all land', async () => {
    await store.enter(entryFor(MEMBER, at(0)));

    expect(await store.leave(GIVEAWAY, MEMBER, at(1))).toBe('left');
    expect(await store.enter(entryFor(MEMBER, at(2)))).toBe('entered');
    expect(await store.entrantCount(GIVEAWAY)).toBe(1);
    expect(await store.leave(GIVEAWAY, MEMBER, at(3))).toBe('left');

    expect(await store.entrantCount(GIVEAWAY)).toBe(0);
    expect((await rowOf(MEMBER)).leftAt).toEqual(at(3));
  });

  test('a replay racing a fresh press still enters the member once, at the fresh press', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(1));

    const [replayed, fresh] = await Promise.all([
      store.enter(entryFor(MEMBER, at(0))),
      store.enter(entryFor(MEMBER, at(2))),
    ]);

    expect(fresh).toBe('entered');
    expect(replayed).not.toBe('entered');
    expect(await store.entrantCount(GIVEAWAY)).toBe(1);
    expect((await rowOf(MEMBER)).joinedAt).toEqual(at(2));
  });
});

describe('a press handled after a later one', () => {
  test('an Enter handled after the Leave that followed it is superseded, not closed', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    expect(await store.leave(GIVEAWAY, MEMBER, at(2))).toBe('left');

    expect(await store.enter(entryFor(MEMBER, at(1)))).toBe('superseded');

    const row = await rowOf(MEMBER);
    expect(row.leftAt).toEqual(at(2));
    expect(row.joinedAt).toEqual(at(0));
    expect(await store.entrantCount(GIVEAWAY)).toBe(0);
  });

  test('an Enter pressed at the same instant as the Leave is superseded', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(1));

    expect(await store.enter(entryFor(MEMBER, at(1)))).toBe('superseded');
    expect((await rowOf(MEMBER)).leftAt).toEqual(at(1));
  });

  test('a late Enter is closed, not superseded, once the giveaway stops running', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(2));
    await store.pause(GUILD, GIVEAWAY, HOST, null, at(3));

    expect(await store.enter(entryFor(MEMBER, at(1)))).toBe('closed');
    expect((await rowOf(MEMBER)).leftAt).toEqual(at(2));
  });

  test('a late Leave after a re-entry is superseded and the member stays in', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(1));
    expect(await store.enter(entryFor(MEMBER, at(3)))).toBe('entered');

    expect(await store.leave(GIVEAWAY, MEMBER, at(2))).toBe('superseded');

    const row = await rowOf(MEMBER);
    expect(row.leftAt).toBeNull();
    expect(row.joinedAt).toEqual(at(3));
    expect(await store.entrantCount(GIVEAWAY)).toBe(1);
  });

  test('a late Leave is not in the draw when the member has since left again', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(1));
    await store.enter(entryFor(MEMBER, at(3)));
    await store.leave(GIVEAWAY, MEMBER, at(4));

    expect(await store.leave(GIVEAWAY, MEMBER, at(2))).toBe('not-entered');
    expect((await rowOf(MEMBER)).leftAt).toEqual(at(4));
  });

  test('a late Leave from a member disqualified since is not in the draw', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(1));
    await store.enter(entryFor(MEMBER, at(3)));
    await store.disqualify(GIVEAWAY, [{ userId: MEMBER, reason: 'lost the role' }], at(4));

    expect(await store.leave(GIVEAWAY, MEMBER, at(2))).toBe('not-entered');

    const row = await rowOf(MEMBER);
    expect(row.leftAt).toBeNull();
    expect(row.disqualifiedAt).toEqual(at(4));
  });

  test('somebody who never entered is not in the draw', async () => {
    expect(await store.leave(GIVEAWAY, MEMBER, at(1))).toBe('not-entered');
    expect(await rowsOf(MEMBER)).toHaveLength(0);
  });
});

describe('a row that changes between the write and the read', () => {
  let held: DbHandle;
  let holder: DbHandle;
  let heldStore: DrizzleGiveawayStore;

  beforeAll(async () => {
    held = createDb(container.getConnectionUri(), {
      max: 1,
      connection: { application_name: 'giveaways-held' },
    });
    holder = createDb(container.getConnectionUri(), { max: 1 });
    heldStore = new DrizzleGiveawayStore(held);

    await handle.client.unsafe(`
      create function hold_press() returns trigger language plpgsql as $$
      begin
        if current_setting('application_name') = 'giveaways-held' then
          perform pg_advisory_lock(7);
          perform pg_advisory_unlock(7);
        end if;
        return null;
      end
      $$
    `);
    await handle.client.unsafe(`
      create trigger hold_press before insert or update on giveaway_entries
      for each statement execute function hold_press()
    `);
  });

  afterAll(async () => {
    await handle.client`drop trigger if exists hold_press on giveaway_entries`;
    await handle.client`drop function if exists hold_press()`;
    await held?.close();
    await holder?.close();
  });

  async function waiting(): Promise<number> {
    const [row] = await handle.client<{ waiting: number }[]>`
      select count(*)::int as waiting from pg_stat_activity
       where application_name = 'giveaways-held'
         and wait_event_type = 'Lock' and wait_event = 'advisory'
    `;

    return row?.waiting ?? 0;
  }

  // Its snapshot predates the trigger: what `meanwhile` commits is hidden from the held write only.
  async function heldWhile<T>(press: () => Promise<T>, meanwhile: () => Promise<unknown>) {
    await holder.client`select pg_advisory_lock(7)`;
    const pressing = press();

    try {
      for (let tries = 0; (await waiting()) === 0; tries += 1) {
        if (tries > 400) throw new Error('the held press never reached its trigger');
        await Bun.sleep(5);
      }

      await meanwhile();
    } finally {
      await holder.client`select pg_advisory_unlock(7)`;
    }

    return pressing;
  }

  test('a Leave that misses an Enter committed before its read still takes the member out', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(1));

    const left = await heldWhile(
      () => heldStore.leave(GIVEAWAY, MEMBER, at(3)),
      async () => expect(await store.enter(entryFor(MEMBER, at(2)))).toBe('entered'),
    );

    expect(left).toBe('left');

    const row = await rowOf(MEMBER);
    expect(row.joinedAt).toEqual(at(2));
    expect(row.leftAt).toEqual(at(3));
    expect(await store.entrantCount(GIVEAWAY)).toBe(0);
  });

  test('an Enter that misses a resume committed before its read takes the leaver back', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.leave(GIVEAWAY, MEMBER, at(1));
    await store.pause(GUILD, GIVEAWAY, HOST, null, at(2));

    const entered = await heldWhile(
      () => heldStore.enter(entryFor(MEMBER, at(4))),
      async () => expect(await store.resume(GUILD, GIVEAWAY, at(3))).not.toBeNull(),
    );

    expect(entered).toBe('entered');

    const row = await rowOf(MEMBER);
    expect(row.joinedAt).toEqual(at(4));
    expect(row.leftAt).toBeNull();
    expect(await store.entrantCount(GIVEAWAY)).toBe(1);
  });

  test('a first Enter that misses a resume committed before its read enters the member', async () => {
    await store.pause(GUILD, GIVEAWAY, HOST, null, at(0));

    const entered = await heldWhile(
      () => heldStore.enter(entryFor(MEMBER, at(2))),
      async () => expect(await store.resume(GUILD, GIVEAWAY, at(1))).not.toBeNull(),
    );

    expect(entered).toBe('entered');
    expect((await rowOf(MEMBER)).joinedAt).toEqual(at(2));
  });

  test('a Leave racing the Enter pressed before it ends where its reply says', async () => {
    for (let round = 0; round < 20; round += 1) {
      const member = String(100000000000000100n + BigInt(round));
      await store.enter(entryFor(member, at(0)));
      await store.leave(GIVEAWAY, member, at(1));

      const [left, entered] = await Promise.all([
        store.leave(GIVEAWAY, member, at(3)),
        store.enter(entryFor(member, at(2))),
      ]);

      expect(entered).toBe('entered');
      expect(['left', 'not-entered']).toContain(left);

      const row = await rowOf(member);
      expect(row.joinedAt).toEqual(at(2));
      expect(row.leftAt).toEqual(left === 'left' ? at(3) : null);
    }
  });
});

describe('draw-time reweigh', () => {
  test('stamps the draw time and keeps only live bonuses in the stored total', async () => {
    await store.enter(entryFor(MEMBER, at(0)));
    await store.enter(entryFor(OTHER, at(0)));
    await store.grantBonus({
      id: 'bonus-live',
      giveawayId: GIVEAWAY,
      userId: MEMBER,
      amount: 4,
      reason: null,
      grantedBy: HOST,
    });
    await store.grantBonus({
      id: 'bonus-revoked',
      giveawayId: GIVEAWAY,
      userId: OTHER,
      amount: 6,
      reason: null,
      grantedBy: HOST,
    });
    expect(await store.revokeBonus(GIVEAWAY, OTHER, HOST, at(5))).toBe(6);

    const breakdown: Reweigh['breakdown'] = [
      { providerId: 'core.has-role', label: 'Has a role', amount: 2, mode: 'add' },
    ];

    expect(
      await store.reweigh(
        GIVEAWAY,
        [
          { userId: MEMBER, totalEntries: 3, breakdown },
          { userId: OTHER, totalEntries: 2, breakdown: [] },
        ],
        at(10),
      ),
    ).toBe(2);

    const member = await rowOf(MEMBER);
    expect(member.revalidatedAt).toEqual(at(10));
    expect(member.totalEntries).toBe(7);
    expect(member.breakdown).toEqual(breakdown);

    const other = await rowOf(OTHER);
    expect(other.revalidatedAt).toEqual(at(10));
    expect(other.totalEntries).toBe(2);
    expect(other.breakdown).toEqual([]);
  });
});

describe('pause and resume', () => {
  test('each resume pushes ends_at by exactly the paused span and adds it to paused_ms', async () => {
    const { endsAt } = await giveawayRow();

    expect((await store.pause(GUILD, GIVEAWAY, HOST, 'restock', at(0)))?.status).toBe('paused');
    expect((await store.resume(GUILD, GIVEAWAY, at(90)))?.status).toBe('running');

    const once = await giveawayRow();
    expect(once.status).toBe('running');
    expect(once.pausedAt).toBeNull();
    expect(once.pausedBy).toBeNull();
    expect(once.pauseReason).toBeNull();
    expect(once.updatedAt).toEqual(at(90));
    expect(once.endsAt).toEqual(new Date(endsAt.getTime() + 90_000));
    expect(once.pausedMs).toBe(90_000);

    await store.pause(GUILD, GIVEAWAY, HOST, null, at(100));
    await store.resume(GUILD, GIVEAWAY, at(130.5));

    const twice = await giveawayRow();
    expect(twice.endsAt).toEqual(new Date(endsAt.getTime() + 120_500));
    expect(twice.pausedMs).toBe(120_500);
  });

  test('resuming a giveaway that is not paused changes nothing', async () => {
    const before = await giveawayRow();

    expect(await store.resume(GUILD, GIVEAWAY, at(10))).toBeNull();
    expect(await giveawayRow()).toEqual(before);
  });
});
