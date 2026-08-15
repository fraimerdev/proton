import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ModuleRegistry } from '@proton/core';
import { createDb, type DbHandle, runMigrations } from '@proton/db';
import { guildModules, guilds } from '@proton/db/schema';
import { pingModule } from '@proton/module-ping';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ModuleConfigError, ModuleConfigService } from '../src/modules/service.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let service: ModuleConfigService;

const GUILD = '900000000000000001';
const ACTOR = '100000000000000001';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);

  const registry = new ModuleRegistry();
  registry.register(pingModule);
  service = new ModuleConfigService(handle, registry);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from audit_trail`;
  await handle.client`delete from guild_modules`;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
});

describe('reading module config', () => {
  test('returns the manifest defaults when no row exists yet', async () => {
    const view = await service.get(GUILD, 'ping');

    expect(view.enabled).toBe(false);
    expect(view.config).toEqual({ enabled: true, response: 'Pong!', restrictToChannel: null });
    expect(view.schemaVersion).toBe(1);
  });

  test('rejects an unknown module rather than inventing a config', async () => {
    await expect(service.get(GUILD, 'nope')).rejects.toThrow(ModuleConfigError);
  });

  /**
   * I5: config is validated on every read, not just on write. The JSONB column
   * is storage, never a trust boundary — a hand-edited row, a bad migration or a
   * restored backup must not reach module code as an unchecked object.
   */
  test('refuses a stored config that no longer satisfies the schema', async () => {
    await handle.db.insert(guildModules).values({
      guildId: GUILD,
      moduleId: 'ping',
      enabled: true,
      config: { enabled: true, response: '', restrictToChannel: null },
      schemaVersion: 1,
    });

    // `response` has min(1) — an empty string must not be handed to the module.
    await expect(service.get(GUILD, 'ping')).rejects.toThrow(/does not satisfy/);
  });

  test('fills in defaults for fields added since the row was written', async () => {
    // A row saved before `restrictToChannel` existed.
    await handle.db.insert(guildModules).values({
      guildId: GUILD,
      moduleId: 'ping',
      enabled: true,
      config: { enabled: true, response: 'Hi' },
      schemaVersion: 1,
    });

    const view = await service.get(GUILD, 'ping');

    expect(view.config.restrictToChannel).toBeNull();
    expect(view.config.response).toBe('Hi');
  });
});

describe('writing module config', () => {
  test('persists the row and stamps the current schema version', async () => {
    await service.update({
      guildId: GUILD,
      moduleId: 'ping',
      enabled: true,
      config: { enabled: true, response: 'Pong!', restrictToChannel: null },
      actorId: ACTOR,
      source: 'dashboard',
    });

    const view = await service.get(GUILD, 'ping');
    expect(view.enabled).toBe(true);
    expect(view.schemaVersion).toBe(1);
  });

  test('rejects an invalid config before it reaches the database', async () => {
    await expect(
      service.update({
        guildId: GUILD,
        moduleId: 'ping',
        config: { enabled: true, response: '', restrictToChannel: null },
        actorId: ACTOR,
        source: 'dashboard',
      }),
    ).rejects.toThrow(ModuleConfigError);

    const rows = await handle.client`select count(*)::int as n from guild_modules`;
    expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
  });

  /**
   * I7: every mutation writes an audit row with before/after diffs. Implemented
   * here, in the one shared domain operation, so no caller can forget it.
   */
  test('writes exactly one audit_trail row with before and after', async () => {
    await service.update({
      guildId: GUILD,
      moduleId: 'ping',
      enabled: true,
      config: { enabled: true, response: 'First', restrictToChannel: null },
      actorId: ACTOR,
      source: 'dashboard',
      ipHash: 'hashed-ip',
    });

    const entries = (await handle.client`
      select actor_id, source, action, before, after, ip_hash from audit_trail
    `) as unknown as Array<{
      actor_id: string;
      source: string;
      action: string;
      before: { enabled: boolean; config: { response: string } };
      after: { enabled: boolean; config: { response: string } };
      ip_hash: string;
    }>;

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.actor_id).toBe(ACTOR);
    expect(entry?.action).toBe('module.ping.update');
    // Before is the pre-change state — defaults, since no row existed.
    expect(entry?.before.enabled).toBe(false);
    expect(entry?.after.enabled).toBe(true);
    expect(entry?.after.config.response).toBe('First');
    // An IP is personal data; only its hash is stored.
    expect(entry?.ip_hash).toBe('hashed-ip');
  });

  test('a second update diffs against the first, not against defaults', async () => {
    await service.update({
      guildId: GUILD,
      moduleId: 'ping',
      enabled: true,
      config: { enabled: true, response: 'First', restrictToChannel: null },
      actorId: ACTOR,
      source: 'dashboard',
    });

    const { before, after } = await service.update({
      guildId: GUILD,
      moduleId: 'ping',
      config: { enabled: true, response: 'Second', restrictToChannel: null },
      actorId: ACTOR,
      source: 'dashboard',
    });

    expect(before.config.response).toBe('First');
    expect(after.config.response).toBe('Second');
    // Enabled was not supplied, so it carries forward rather than resetting.
    expect(after.enabled).toBe(true);

    const rows = await handle.client`select count(*)::int as n from audit_trail`;
    expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(2);
  });

  test('a failed write leaves no audit row behind', async () => {
    await expect(
      service.update({
        guildId: GUILD,
        moduleId: 'ping',
        config: { enabled: true, response: '', restrictToChannel: null },
        actorId: ACTOR,
        source: 'dashboard',
      }),
    ).rejects.toThrow();

    const rows = await handle.client`select count(*)::int as n from audit_trail`;
    expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
  });
});
