import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DbHandle, runMigrations } from '@proton/db';
import { guilds } from '@proton/db/schema';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GuildService } from '../src/guilds/service.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let service: GuildService;

const JOINED = '900000000000000001';
const LEFT = '900000000000000002';
const NEVER = '900000000000000003';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);

  service = new GuildService(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: JOINED, name: 'Still here' },
    { id: LEFT, name: 'Kicked', leftAt: new Date('2026-05-01T00:00:00.000Z') },
  ]);
});

describe('GuildService.presentIds', () => {
  test('reports a guild Proton is still in', async () => {
    expect(await service.presentIds([JOINED])).toEqual([JOINED]);
  });

  // The row survives a kick so cases and config outlive a re-invite, which is exactly why the
  // dashboard cannot ask "is there a row" and has to ask this instead.
  test('a guild Proton was removed from keeps its row but is not present', async () => {
    expect(await service.presentIds([LEFT])).toEqual([]);
  });

  test('a guild Proton has never been in is not present', async () => {
    expect(await service.presentIds([NEVER])).toEqual([]);
  });

  test('answers a mixed list with only the joined ids', async () => {
    expect(await service.presentIds([NEVER, LEFT, JOINED])).toEqual([JOINED]);
  });

  test('an empty list never reaches the database', async () => {
    expect(await service.presentIds([])).toEqual([]);
  });

  test('a re-invite makes the guild present again', async () => {
    await service.ensureGuild({ guildId: LEFT, name: 'Kicked' });

    expect(await service.presentIds([LEFT])).toEqual([LEFT]);
  });
});
