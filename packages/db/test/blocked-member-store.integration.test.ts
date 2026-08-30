import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BlockMemberInput } from '@proton/core';
import { blockedMemberQuerySchema } from '@proton/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DrizzleBlockedMemberStore } from '../src/blocked-member-store.ts';
import { createDb, type DbHandle } from '../src/client.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds } from '../src/schema/index.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleBlockedMemberStore;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';

const MEMBER = '400000000000000001';
const OTHER = '400000000000000002';

const MOD = '100000000000000000';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleBlockedMemberStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from blocked_members`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
});

function input(overrides: Partial<BlockMemberInput> = {}): BlockMemberInput {
  return {
    guildId: GUILD,
    userId: MEMBER,
    moduleId: 'honeypot',
    blockedBy: 'proton:honeypot',
    reason: 'Posted in a honeypot channel.',
    idempotencyKey: 'honeypot:900000000000000001:1400000000000000001:block',
    ...overrides,
  };
}

function query(overrides: Record<string, unknown> = {}) {
  return blockedMemberQuerySchema.parse(overrides);
}

async function rowCount(): Promise<number> {
  const rows = await handle.client`select count(*)::int as n from blocked_members`;
  return (rows[0] as { n: number }).n;
}

describe('block', () => {
  test('records the member, with the reason and the evidence it was given', async () => {
    expect(
      await store.block(input({ evidence: { channelId: '5', messageId: '6' }, caseId: 'case-1' })),
    ).toEqual({ blocked: true });

    const found = await store.find(GUILD, MEMBER);

    expect(found?.reason).toBe('Posted in a honeypot channel.');
    expect(found?.moduleId).toBe('honeypot');
    expect(found?.caseId).toBe('case-1');
    expect(found?.evidence).toEqual({ channelId: '5', messageId: '6' });
    expect(found?.liftedAt).toBeNull();
  });

  test('a redelivered event under the same key writes nothing a second time', async () => {
    expect(await store.block(input())).toEqual({ blocked: true });
    expect(await store.block(input())).toEqual({ blocked: false });

    expect(await rowCount()).toBe(1);
  });

  test('a second module blocking someone already blocked keeps the first reason', async () => {
    await store.block(input());

    expect(
      await store.block(
        input({ moduleId: 'antiraid', reason: 'Joined in a raid.', idempotencyKey: 'antiraid:1' }),
      ),
    ).toEqual({ blocked: false });

    expect((await store.find(GUILD, MEMBER))?.reason).toBe('Posted in a honeypot channel.');
    expect(await rowCount()).toBe(1);
  });

  // The load-bearing case for the non-partial idempotency index. A moderator lifts the block, then
  // the gateway RESUMEs and redelivers the message that caused it. Without the plain unique index
  // the live index no longer conflicts, and the member is silently blocked again.
  test('a redelivery after a moderator lifted it does not re-block them', async () => {
    await store.block(input());
    await store.lift({ guildId: GUILD, userId: MEMBER, liftedBy: MOD, liftReason: 'On appeal.' });

    expect(await store.block(input())).toEqual({ blocked: false });
    expect(await store.find(GUILD, MEMBER)).toBeNull();
    expect(await rowCount()).toBe(1);
  });

  test('a genuinely new block after a lift is allowed, and leaves the old row standing', async () => {
    await store.block(input());
    await store.lift({ guildId: GUILD, userId: MEMBER, liftedBy: MOD, liftReason: 'On appeal.' });

    expect(await store.block(input({ idempotencyKey: 'honeypot:second' }))).toEqual({
      blocked: true,
    });

    expect(await rowCount()).toBe(2);
    expect(await store.find(GUILD, MEMBER)).not.toBeNull();
  });

  test('refuses a blank reason before Postgres is ever touched', async () => {
    await expect(store.block(input({ reason: '  ' }))).rejects.toThrow();
    expect(await rowCount()).toBe(0);
  });
});

describe('find', () => {
  test('is scoped to one guild', async () => {
    await store.block(input());

    expect(await store.find(OTHER_GUILD, MEMBER)).toBeNull();
  });

  test('answers null once the block is lifted', async () => {
    await store.block(input());

    expect(await store.find(GUILD, MEMBER)).not.toBeNull();

    await store.lift({ guildId: GUILD, userId: MEMBER, liftedBy: MOD, liftReason: 'Mistake.' });

    expect(await store.find(GUILD, MEMBER)).toBeNull();
  });
});

describe('list', () => {
  beforeEach(async () => {
    await store.block(input());
    await store.block(
      input({ userId: OTHER, idempotencyKey: 'honeypot:other', moduleId: 'antiraid' }),
    );
    await store.lift({ guildId: GUILD, userId: OTHER, liftedBy: MOD, liftReason: 'Appealed.' });
  });

  test('shows only live blocks by default', async () => {
    const { rows, total } = await store.list(GUILD, query());

    expect(total).toBe(1);
    expect(rows.map((row) => row.userId)).toEqual([MEMBER]);
  });

  test('shows only lifted blocks when asked', async () => {
    const { rows } = await store.list(GUILD, query({ state: 'lifted' }));

    expect(rows.map((row) => row.userId)).toEqual([OTHER]);
    expect(rows[0]?.liftReason).toBe('Appealed.');
  });

  test('shows both when asked for all', async () => {
    expect((await store.list(GUILD, query({ state: 'all' }))).total).toBe(2);
  });

  test('filters by member and by module', async () => {
    expect((await store.list(GUILD, query({ state: 'all', userId: OTHER }))).total).toBe(1);
    expect((await store.list(GUILD, query({ state: 'all', moduleId: 'antiraid' }))).total).toBe(1);
  });

  test('counts the whole filtered set, not the page', async () => {
    const page = await store.list(GUILD, query({ state: 'all', pageSize: 1 }));

    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(2);
  });

  test('pages disjointly', async () => {
    const first = await store.list(GUILD, query({ state: 'all', pageSize: 1, page: 1 }));
    const second = await store.list(GUILD, query({ state: 'all', pageSize: 1, page: 2 }));

    expect(first.rows[0]?.id).not.toBe(second.rows[0]?.id);
  });

  test('reverses on asc', async () => {
    const desc = await store.list(GUILD, query({ state: 'all' }));
    const asc = await store.list(GUILD, query({ state: 'all', order: 'asc' }));

    expect(asc.rows.map((r) => r.id)).toEqual([...desc.rows.map((r) => r.id)].reverse());
  });

  test('is scoped to one guild', async () => {
    expect((await store.list(OTHER_GUILD, query({ state: 'all' }))).total).toBe(0);
  });
});

describe('lift', () => {
  test('records who lifted it and why', async () => {
    await store.block(input());

    expect(
      await store.lift({ guildId: GUILD, userId: MEMBER, liftedBy: MOD, liftReason: 'On appeal.' }),
    ).toEqual({ lifted: true, userId: MEMBER });

    const [row] = (await store.list(GUILD, query({ state: 'lifted' }))).rows;

    expect(row?.liftedBy).toBe(MOD);
    expect(row?.liftReason).toBe('On appeal.');
    expect(row?.liftedAt).not.toBeNull();
  });

  test('lifting twice reports the second as nothing to lift', async () => {
    await store.block(input());
    await store.lift({ guildId: GUILD, userId: MEMBER, liftedBy: MOD, liftReason: 'On appeal.' });

    expect(
      await store.lift({ guildId: GUILD, userId: MEMBER, liftedBy: MOD, liftReason: 'Again.' }),
    ).toEqual({ lifted: false, userId: MEMBER });
  });

  test('lifting somebody who was never blocked is not an error', async () => {
    expect(
      await store.lift({ guildId: GUILD, userId: MEMBER, liftedBy: MOD, liftReason: 'Nothing.' }),
    ).toEqual({ lifted: false, userId: MEMBER });
  });
});

describe('the guild foreign key', () => {
  test('takes its blocks with it when the guild is deleted', async () => {
    await store.block(input());

    await handle.client`delete from guilds where id = ${GUILD}`;

    expect(await rowCount()).toBe(0);
  });
});
