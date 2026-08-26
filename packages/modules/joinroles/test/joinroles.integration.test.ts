import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  DefaultActionExecutor,
  type GuildState,
  RedisDedupeStore,
  RedisGuildStateStore,
  type ResolveContextHints,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
  resolvePrecheckContext,
} from '@proton/core';
import { createDb, type DbHandle, DrizzleCaseRecorder, runMigrations } from '@proton/db';
import { guilds } from '@proton/db/schema';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { createJoinRolesListener } from '../src/listeners.ts';
import {
  BOT_ROLE,
  config,
  event,
  GUILD,
  MEMBER,
  ROLE_ABOVE_BOT,
  ROLE_LOW,
  STATE,
  silent,
} from './harness.ts';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let handle: DbHandle;
let redis: Redis;

const BOT_USER = '100000000000000098';

class FakeRest implements RestProxyClient {
  readonly calls: RestRequestOptions[] = [];
  response: RestResponse = { status: 204, body: null };

  async request(options: RestRequestOptions): Promise<RestResponse> {
    this.calls.push(options);
    return this.response;
  }
}

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  handle = createDb(postgres.getConnectionUri());
  await runMigrations(handle);
  redis = new Redis(redisContainer.getConnectionUrl());
}, 240_000);

afterAll(async () => {
  await handle?.close();
  redis?.disconnect();
  await Promise.all([postgres?.stop(), redisContainer?.stop()]);
}, 240_000);

beforeEach(async () => {
  await redis.flushall();
  await handle.client`delete from cases`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

interface Built {
  rest: FakeRest;
  executor: DefaultActionExecutor;
}

async function build(state: GuildState = STATE): Promise<Built> {
  const guildState = new RedisGuildStateStore(redis);
  await guildState.put(state);

  const rest = new FakeRest();
  const executor = new DefaultActionExecutor({
    dedupe: new RedisDedupeStore(redis),
    rest,
    recorder: new DrizzleCaseRecorder(handle),

    resolveContext: async (request, hints) => {
      const result = await resolvePrecheckContext(
        {
          store: guildState,
          botUserId: BOT_USER,
          fetchMemberRoles: async () => [],
        },
        request,
        (hints ?? {}) as ResolveContextHints,
      );

      return 'context' in result ? result.context : result;
    },
  });

  return { rest, executor };
}

function caseRows(): Promise<Array<Record<string, unknown>>> {
  return handle.client`select * from cases` as unknown as Promise<Array<Record<string, unknown>>>;
}

describe('join roles end to end', () => {
  test('a configured role reaches Discord and is written to the case ledger', async () => {
    const { rest, executor } = await build();
    const listener = createJoinRolesListener({
      guildState: { get: async () => STATE },
      botUserId: BOT_USER,
    });

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    });

    expect(rest.calls).toHaveLength(1);
    expect(rest.calls[0]?.method).toBe('PUT');
    expect(rest.calls[0]?.path).toBe(`/guilds/${GUILD}/members/${MEMBER}/roles/${ROLE_LOW}`);

    const rows = await caseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.module_id).toBe('joinroles');
    expect(rows[0]?.type).toBe('add_role');
    expect(rows[0]?.target_id).toBe(MEMBER);
    expect(rows[0]?.dry_run).toBe(false);
  });

  test('a redelivered join calls Discord once', async () => {
    const { rest, executor } = await build();
    const listener = createJoinRolesListener({
      guildState: { get: async () => STATE },
      botUserId: BOT_USER,
    });
    const ctx = {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: silent,
    };

    await listener.handler(event('guildMemberAdd'), ctx);
    await listener.handler(event('guildMemberAdd'), ctx);

    expect(rest.calls).toHaveLength(1);
    expect(await caseRows()).toHaveLength(1);
  });

  test('a role above the bot is refused with a reason naming the permission problem', async () => {
    // planGrant is bypassed with a null guild state so the refusal comes from the executor's
    // own precheck — the path a guild hits when Proton's role is dragged down after setup.
    const { rest, executor } = await build();
    const listener = createJoinRolesListener({
      guildState: { get: async () => null },
      botUserId: BOT_USER,
    });

    const logged: string[] = [];

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_ABOVE_BOT] }),
      executor,
      logger: { info: () => {}, warn: () => {}, error: (m) => logged.push(m) },
    });

    expect(rest.calls).toEqual([]);
    expect(logged.join(' ')).toContain('could not grant role');

    const rows = await caseRows();
    expect(rows).toEqual([]);
  });

  test('a missing MANAGE_ROLES permission is named, not swallowed', async () => {
    const powerless: GuildState = {
      ...STATE,
      roles: new Map([...STATE.roles].map(([id, role]) => [id, { ...role, permissions: 0n }])),
      botRoleIds: [BOT_ROLE],
    };

    const { rest, executor } = await build(powerless);
    const listener = createJoinRolesListener({
      guildState: { get: async () => powerless },
      botUserId: BOT_USER,
    });

    const logged: string[] = [];

    await listener.handler(event('guildMemberAdd'), {
      guildId: GUILD,
      config: config({ memberRoleIds: [ROLE_LOW] }),
      executor,
      logger: { info: () => {}, warn: () => {}, error: (m) => logged.push(m) },
    });

    expect(rest.calls).toEqual([]);
    expect(logged.join(' ')).toContain('Manage Roles');
  });
});
