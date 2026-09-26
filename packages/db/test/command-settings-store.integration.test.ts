import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { type CommandSettings, DEFAULT_COMMAND_SETTINGS } from '@proton/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from '../src/client.ts';
import {
  type CommandSettingsAudit,
  DrizzleCommandSettingsStore,
  type GuildCommandSettings,
} from '../src/command-settings-store.ts';
import { runMigrations } from '../src/migrator.ts';
import { guilds } from '../src/schema/index.ts';
import { firstRow, rows } from './helpers.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let store: DrizzleCommandSettingsStore;

const GUILD = '900000000000000001';
const OTHER_GUILD = '900000000000000002';
const ACTOR = '100000000000000001';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);
  store = new DrizzleCommandSettingsStore(handle);
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values([
    { id: GUILD, name: 'test guild' },
    { id: OTHER_GUILD, name: 'other guild' },
  ]);
});

let auditIds = 0;

function audit(overrides: Partial<CommandSettingsAudit> = {}): CommandSettingsAudit {
  auditIds += 1;
  return {
    id: `audit-${auditIds}`,
    actorId: ACTOR,
    source: 'dashboard',
    action: 'command.update',
    before: null,
    after: null,
    ...overrides,
  };
}

function settings(overrides: Partial<CommandSettings> = {}): CommandSettings {
  return { ...DEFAULT_COMMAND_SETTINGS, ...overrides };
}

async function auditCount(guildId = GUILD): Promise<number> {
  const found = await firstRow<{ n: number }>(
    handle.client`select count(*)::int as n from audit_trail where guild_id = ${guildId}`,
  );
  return found.n;
}

async function commandCount(): Promise<number> {
  const found = await firstRow<{ n: number }>(
    handle.client`select count(*)::int as n from guild_commands`,
  );
  return found.n;
}

describe('reads', () => {
  test('a guild with nothing saved lists nothing', async () => {
    expect(await store.list(GUILD)).toEqual({});
    expect(await store.get(GUILD, 'ban')).toBeNull();
  });

  test('a row with only its keys reads as the defaults', async () => {
    await handle.client`insert into guild_commands (guild_id, command_key) values (${GUILD}, 'ban')`;

    const found = await store.get(GUILD, 'ban');

    expect(found).toEqual({ ...DEFAULT_COMMAND_SETTINGS, updatedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(found?.updatedAt ?? ''))).toBe(false);
  });

  test('list keys the guild’s rows by command key and leaves other guilds out', async () => {
    await store.write(GUILD, 'ban', () => ({
      next: settings({ name: 'punish' }),
      audit: audit(),
    }));
    await store.write(GUILD, 'user:Report user', () => ({
      next: settings({ enabled: false }),
      audit: audit(),
    }));
    await store.write(OTHER_GUILD, 'kick', () => ({ next: settings(), audit: audit() }));

    const listed = await store.list(GUILD);

    expect(Object.keys(listed)).toEqual(['ban', 'user:Report user']);
    expect(listed.ban?.name).toBe('punish');
    expect(listed['user:Report user']?.enabled).toBe(false);
  });
});

describe('write', () => {
  test('stores every setting and its audit row, and reads them back', async () => {
    const next = settings({
      name: 'punish',
      description: 'Punish a member',
      optionDescriptions: { 'add.user': 'Who to punish', 'blacklist.add.user': 'Who to block' },
      privateReply: true,
    });

    const written = await store.write(GUILD, 'ban', () => ({
      next,
      audit: audit({ id: 'audit-save', before: { key: 'ban' }, after: { key: 'ban', next } }),
    }));

    expect(written?.settings).toEqual({ ...next, updatedAt: expect.any(String) });
    expect(await store.get(GUILD, 'ban')).toEqual(written?.settings ?? null);

    const stored = await firstRow<{ schema_version: number; updated_by: string }>(
      handle.client`select schema_version, updated_by from guild_commands
                     where guild_id = ${GUILD} and command_key = 'ban'`,
    );
    expect(stored).toEqual({ schema_version: 1, updated_by: ACTOR });

    const logged = await firstRow<{ action: string; after: unknown }>(
      handle.client`select action, after from audit_trail where id = 'audit-save'`,
    );
    expect(logged).toEqual({ action: 'command.update', after: { key: 'ban', next } });
  });

  test('the decision sees every row of the guild, and none of another', async () => {
    await store.write(GUILD, 'kick', () => ({ next: settings({ name: 'boot' }), audit: audit() }));
    await store.write(OTHER_GUILD, 'warn', () => ({ next: settings(), audit: audit() }));
    let seen: GuildCommandSettings = {};

    await store.write(GUILD, 'ban', (current) => {
      seen = current;
      return { next: settings(), audit: audit() };
    });

    expect(Object.keys(seen)).toEqual(['kick']);
    expect(seen.kick?.name).toBe('boot');
  });

  test('a second save replaces the row and moves its time forward', async () => {
    const first = await store.write(GUILD, 'ban', () => ({
      next: settings({ name: 'punish' }),
      audit: audit(),
    }));
    await Bun.sleep(5);
    const second = await store.write(GUILD, 'ban', (current) => ({
      next: { ...settings(), enabled: current.ban?.enabled ?? true, description: 'Ban someone' },
      audit: audit(),
    }));

    expect(second?.settings.name).toBeNull();
    expect(second?.settings.description).toBe('Ban someone');
    expect(Date.parse(second?.settings.updatedAt ?? '')).toBeGreaterThan(
      Date.parse(first?.settings.updatedAt ?? ''),
    );
    expect(await commandCount()).toBe(1);
    expect(await auditCount()).toBe(2);
  });

  test('a decision to write nothing leaves no row and no audit entry', async () => {
    expect(await store.write(GUILD, 'ban', () => null)).toBeNull();

    expect(await commandCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  test('a decision that throws leaves the stored row as it was', async () => {
    await store.write(GUILD, 'ban', () => ({ next: settings({ name: 'punish' }), audit: audit() }));

    await expect(
      store.write(GUILD, 'ban', () => {
        throw new Error('command_changed');
      }),
    ).rejects.toThrow('command_changed');

    expect((await store.get(GUILD, 'ban'))?.name).toBe('punish');
    expect(await auditCount()).toBe(1);
  });

  test('an audit row that cannot be written takes the settings change with it', async () => {
    await store.write(GUILD, 'ban', () => ({
      next: settings({ name: 'punish' }),
      audit: audit({ id: 'taken' }),
    }));

    await expect(
      store.write(GUILD, 'ban', () => ({
        next: settings({ name: 'smite' }),
        audit: audit({ id: 'taken' }),
      })),
    ).rejects.toThrow();

    expect((await store.get(GUILD, 'ban'))?.name).toBe('punish');
  });

  test('concurrent saves in one guild run one after the other, each seeing the last', async () => {
    let releaseFirst = (): void => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let secondSaw: GuildCommandSettings | null = null;

    const first = store.write(GUILD, 'ban', async () => {
      firstEntered();
      await firstHeld;
      return { next: settings({ name: 'punish' }), audit: audit() };
    });
    await entered;

    const second = store.write(GUILD, 'kick', (current) => {
      secondSaw = current;
      return { next: settings({ name: 'boot' }), audit: audit() };
    });

    await Bun.sleep(200);
    expect(secondSaw).toBeNull();

    releaseFirst();
    await Promise.all([first, second]);

    expect(Object.keys(secondSaw ?? {})).toEqual(['ban']);
    expect((secondSaw as GuildCommandSettings | null)?.ban?.name).toBe('punish');
  });

  test('saves in different guilds do not wait for each other', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const blocked = store.write(GUILD, 'ban', async () => {
      await held;
      return { next: settings(), audit: audit() };
    });

    const other = await store.write(OTHER_GUILD, 'ban', () => ({
      next: settings({ name: 'punish' }),
      audit: audit(),
    }));
    expect(other?.settings.name).toBe('punish');

    release();
    await blocked;
  });

  test('a server with no guilds row cannot be written to', async () => {
    await expect(
      store.write('900000000000000099', 'ban', () => ({ next: settings(), audit: audit() })),
    ).rejects.toThrow();
  });

  test('removing the server removes its command settings', async () => {
    await store.write(GUILD, 'ban', () => ({ next: settings({ name: 'punish' }), audit: audit() }));

    await handle.client`delete from guilds where id = ${GUILD}`;

    expect(
      await rows(handle.client`select 1 from guild_commands where guild_id = ${GUILD}`),
    ).toHaveLength(0);
  });
});
