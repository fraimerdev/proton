import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createDb, type DbHandle, runMigrations } from '@proton/db';
import { guilds } from '@proton/db/schema';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { BotGuildSource } from '../src/guilds/directory.ts';
import { GuildService } from '../src/guilds/service.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;

const JOINED = '900000000000000001';
const LEFT = '900000000000000002';
const NEVER = '900000000000000003';
const UNREGISTERED = '900000000000000004';

class FakeDirectory implements BotGuildSource {
  #answer: ReadonlyMap<string, string> | null;

  constructor(ids: readonly string[] | null) {
    this.#answer = ids === null ? null : new Map(ids.map((id) => [id, `guild ${id}`]));
  }

  guilds(): Promise<ReadonlyMap<string, string> | null> {
    return Promise.resolve(this.#answer);
  }
}

function serviceSeeing(ids: readonly string[] | null): GuildService {
  return new GuildService(handle, new FakeDirectory(ids));
}

async function rowFor(id: string) {
  const rows = await handle.client`select id, name, left_at from guilds where id = ${id}`;
  return rows[0] as { id: string; name: string; left_at: Date | null } | undefined;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
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

describe('GuildService.presence', () => {
  test('reports a guild Discord says Proton is in', async () => {
    expect(await serviceSeeing([JOINED]).presence([JOINED])).toEqual({
      present: [JOINED],
      known: true,
    });
  });

  test('a guild Proton has never been in is not present', async () => {
    expect(await serviceSeeing([JOINED]).presence([NEVER])).toEqual({ present: [], known: true });
  });

  test('answers a mixed list with only the ids Discord confirms', async () => {
    expect(await serviceSeeing([JOINED]).presence([NEVER, LEFT, JOINED])).toEqual({
      present: [JOINED],
      known: true,
    });
  });

  // The whole point of the change: a row nothing ever corrected said Proton was still here, and
  // the picker offered a settings page whose saves went into a server the bot had been kicked from.
  test('a stale row is not enough — Discord decides', async () => {
    expect(await serviceSeeing([]).presence([JOINED])).toEqual({ present: [], known: true });
  });

  test('a guild Proton is in but was never registered for is still present', async () => {
    expect(await serviceSeeing([UNREGISTERED]).presence([UNREGISTERED])).toEqual({
      present: [UNREGISTERED],
      known: true,
    });
  });

  test('an empty list never reaches Discord or the database', async () => {
    expect(await serviceSeeing(null).presence([])).toEqual({ present: [], known: true });
  });

  test('an unreachable Discord is unknown, not absent everywhere', async () => {
    expect(await serviceSeeing(null).presence([JOINED, LEFT])).toEqual({
      present: [],
      known: false,
    });
  });
});

describe('the row repair presence does on the way past', () => {
  // guild_modules keys to guilds.id, so without a row every save on that server's page fails on a
  // foreign key — for a server Discord has just confirmed the bot is sitting in.
  test('writes the missing row for a guild Discord confirms', async () => {
    await serviceSeeing([UNREGISTERED]).presence([UNREGISTERED]);

    expect(await rowFor(UNREGISTERED)).toMatchObject({
      id: UNREGISTERED,
      name: `guild ${UNREGISTERED}`,
      left_at: null,
    });
  });

  test('clears a left_at that Discord contradicts', async () => {
    await serviceSeeing([LEFT]).presence([LEFT]);

    expect((await rowFor(LEFT))?.left_at).toBeNull();
  });

  // Only ever additive. Two deployments share one database, so a guild this bot cannot see may be
  // one the other bot is in, and marking it left here would evict it from that bot's picker.
  test('never marks a row left for a guild Discord did not list', async () => {
    await serviceSeeing([]).presence([JOINED]);

    expect((await rowFor(JOINED))?.left_at).toBeNull();
  });

  test('leaves an existing name alone', async () => {
    await serviceSeeing([JOINED]).presence([JOINED]);

    expect((await rowFor(JOINED))?.name).toBe('Still here');
  });

  test('writes nothing when Discord could not be asked', async () => {
    await serviceSeeing(null).presence([UNREGISTERED]);

    expect(await rowFor(UNREGISTERED)).toBeUndefined();
  });
});
