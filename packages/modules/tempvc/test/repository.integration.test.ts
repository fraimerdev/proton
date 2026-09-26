import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DbHandle, guilds, runMigrations } from '@proton/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { DrizzleTempVoiceRepository, type ReserveInput } from '../src/repository.ts';
import { tempVoiceChannels } from '../src/table.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let repo: DrizzleTempVoiceRepository;

const GUILD = '900000000000000001';
const HUB = '500000000000000001';
const OWNER = '100000000000000001';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  repo = new DrizzleTempVoiceRepository(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

function input(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    id: 'tvc-1',
    guildId: GUILD,
    hubChannelId: HUB,
    ownerId: OWNER,
    maxChannelsPerUser: 1,
    ...overrides,
  };
}

describe('reserving', () => {
  test('returns the decoded row, not the raw driver row', async () => {
    const reservation = await repo.reserve(input());
    if (!('reserved' in reservation)) throw new Error('the reservation was refused');

    const { reserved } = reservation;
    expect(reserved).toMatchObject({
      id: 'tvc-1',
      guildId: GUILD,
      hubChannelId: HUB,
      ownerId: OWNER,
      channelId: null,
      status: 'reserving',
      deleteAfter: null,
    });
    expect(reserved.createdAt).toBeInstanceOf(Date);
    expect(reserved.lastActiveAt).toBeInstanceOf(Date);

    const rows = await handle.db
      .select()
      .from(tempVoiceChannels)
      .where(eq(tempVoiceChannels.id, 'tvc-1'));
    expect(rows).toEqual([reserved]);
  });

  test('refuses past the per-member cap and writes nothing', async () => {
    await repo.reserve(input());
    await repo.attach('tvc-1', '500000000000000002');

    const reservation = await repo.reserve(input({ id: 'tvc-2' }));

    expect(reservation).toEqual({ refused: 'at_limit', live: 1 });

    const rows = await handle.db
      .select()
      .from(tempVoiceChannels)
      .where(eq(tempVoiceChannels.ownerId, OWNER));
    expect(rows.map((row) => row.id)).toEqual(['tvc-1']);
  });
});

describe('reopening', () => {
  test('puts a closing row back to live, where the sweeper and the cap can see it again', async () => {
    await repo.reserve(input());
    await repo.attach('tvc-1', '500000000000000002');
    expect(await repo.beginClose('tvc-1')).toBe(true);

    await repo.reopen('tvc-1');

    expect((await repo.byId('tvc-1'))?.status).toBe('live');
    expect(await repo.ownedBy(GUILD, OWNER)).toHaveLength(1);
    expect(await repo.beginClose('tvc-1')).toBe(true);
  });

  test('never promotes a reservation that was not closing', async () => {
    await repo.reserve(input());

    await repo.reopen('tvc-1');

    expect((await repo.byId('tvc-1'))?.status).toBe('reserving');
  });
});
