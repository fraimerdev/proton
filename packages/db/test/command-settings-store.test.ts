import { describe, expect, test } from 'bun:test';
import { type CommandSettings, DEFAULT_COMMAND_SETTINGS } from '@proton/core';
import {
  type CommandSettingsAudit,
  DrizzleCommandSettingsStore,
  toCommandSettingsView,
} from '../src/command-settings-store.ts';
import type { GuildCommandRow } from '../src/schema/guild-commands.ts';
import { type FakeQuery, fakePostgres } from './fake-postgres.ts';

const GUILD = '900000000000000001';
const ACTOR = '100000000000000001';
const EARLIER = '2026-09-21T10:00:00.000Z';
const LATER = '2026-09-22T08:30:00.250Z';

function dbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guild_id: GUILD,
    command_key: 'ban',
    enabled: true,
    name: null,
    description: null,
    option_descriptions: {},
    private_reply: null,
    schema_version: 1,
    updated_by: ACTOR,
    updated_at: EARLIER,
    ...overrides,
  };
}

function row(overrides: Partial<GuildCommandRow> = {}): GuildCommandRow {
  return {
    guildId: GUILD,
    commandKey: 'ban',
    enabled: true,
    name: null,
    description: null,
    optionDescriptions: {},
    privateReply: null,
    schemaVersion: 1,
    updatedBy: ACTOR,
    updatedAt: new Date(EARLIER),
    ...overrides,
  };
}

const isLock = (query: FakeQuery) => query.sql.includes('pg_advisory_xact_lock');
const isRead = (query: FakeQuery) => query.sql.startsWith('select') && !isLock(query);
const isUpsert = (query: FakeQuery) => query.sql.startsWith('insert into "guild_commands"');
const isAudit = (query: FakeQuery) => query.sql.startsWith('insert into "audit_trail"');

function audit(overrides: Partial<CommandSettingsAudit> = {}): CommandSettingsAudit {
  return {
    id: 'audit-1',
    actorId: ACTOR,
    source: 'dashboard',
    action: 'command.update',
    before: { key: 'ban' },
    after: { key: 'ban' },
    ipHash: null,
    ...overrides,
  };
}

function storeWith(rows: Record<string, unknown>[], written = dbRow({ updated_at: LATER })) {
  const fake = fakePostgres((query) => {
    if (isRead(query)) return rows;
    if (isUpsert(query)) return [written];
    return [];
  });

  return { ...fake, store: new DrizzleCommandSettingsStore(fake.handle) };
}

const renamed: CommandSettings = {
  ...DEFAULT_COMMAND_SETTINGS,
  name: 'punish',
  optionDescriptions: { 'add.user': 'Who to punish' },
};

describe('toCommandSettingsView', () => {
  test('reads the columns as settings and the time as an ISO string', () => {
    expect(
      toCommandSettingsView(
        row({
          enabled: false,
          name: 'punish',
          description: 'Punish a member',
          optionDescriptions: { 'add.user': 'Who' },
          privateReply: true,
        }),
      ),
    ).toEqual({
      enabled: false,
      name: 'punish',
      description: 'Punish a member',
      optionDescriptions: { 'add.user': 'Who' },
      privateReply: true,
      updatedAt: EARLIER,
    });
  });

  test('a row with nothing customized reads as the defaults', () => {
    expect(toCommandSettingsView(row())).toEqual({
      ...DEFAULT_COMMAND_SETTINGS,
      updatedAt: EARLIER,
    });
  });

  test.each([
    ['a number for a description', { 'add.user': 5 }],
    ['an array', ['Who']],
    ['JSON null', null],
  ])('option descriptions holding %s fall back to none and keep the rest', (_, stored) => {
    const view = toCommandSettingsView(
      row({ name: 'punish', optionDescriptions: stored as unknown as Record<string, string> }),
    );

    expect(view.optionDescriptions).toEqual({});
    expect(view.name).toBe('punish');
  });
});

describe('DrizzleCommandSettingsStore reads', () => {
  test('list keys every row of the guild by its command key', async () => {
    const { store, queries } = storeWith([
      dbRow({ command_key: 'ban', name: 'punish' }),
      dbRow({ command_key: 'user:Report user', enabled: false }),
    ]);

    const settings = await store.list(GUILD);

    expect(Object.keys(settings)).toEqual(['ban', 'user:Report user']);
    expect(settings.ban?.name).toBe('punish');
    expect(settings['user:Report user']?.enabled).toBe(false);
    expect(queries()[0]?.params).toEqual([GUILD]);
  });

  test('get reads one command, and nothing when it was never saved', async () => {
    expect((await storeWith([dbRow({ name: 'punish' })]).store.get(GUILD, 'ban'))?.name).toBe(
      'punish',
    );
    expect(await storeWith([]).store.get(GUILD, 'ban')).toBeNull();
  });
});

describe('DrizzleCommandSettingsStore.write', () => {
  test('locks the guild, re-reads all of its rows, then upserts and audits in one transaction', async () => {
    const { store, steps } = storeWith([dbRow({ command_key: 'kick', name: 'boot' })]);

    await store.write(GUILD, 'ban', () => ({ next: renamed, audit: audit() }));

    const kinds = steps.map((step) =>
      typeof step === 'string'
        ? step
        : isLock(step)
          ? 'lock'
          : isRead(step)
            ? 'read'
            : isUpsert(step)
              ? 'upsert'
              : isAudit(step)
                ? 'audit'
                : step.sql,
    );
    expect(kinds).toEqual(['begin', 'lock', 'read', 'upsert', 'audit', 'commit']);
  });

  test('the lock is keyed by the guild alone, and the read is not narrowed to one command', async () => {
    const { store, queries } = storeWith([]);

    await store.write(GUILD, 'ban', () => ({ next: renamed, audit: audit() }));

    const lock = queries().find(isLock);
    expect(lock?.sql).toContain('pg_advisory_xact_lock(hashtext($1))');
    expect(lock?.params).toEqual([`guild_commands:${GUILD}`]);

    const read = queries().find(isRead);
    expect(read?.params).toEqual([GUILD]);
    expect(read?.sql).not.toContain('"command_key" =');
  });

  test('decides from the rows read inside the transaction', async () => {
    const { store } = storeWith([
      dbRow({ command_key: 'kick', name: 'boot', updated_at: LATER }),
      dbRow({ command_key: 'ban', description: 'Old' }),
    ]);
    let seen: unknown;

    await store.write(GUILD, 'ban', (current) => {
      seen = current;
      return { next: renamed, audit: audit() };
    });

    expect(seen).toEqual({
      ban: { ...DEFAULT_COMMAND_SETTINGS, description: 'Old', updatedAt: EARLIER },
      kick: { ...DEFAULT_COMMAND_SETTINGS, name: 'boot', updatedAt: LATER },
    });
  });

  test('writes every setting with the schema version, the actor and the lock-time clock', async () => {
    const { store, queries } = storeWith([]);

    await store.write(GUILD, 'ban', () => ({
      next: { ...renamed, enabled: false, privateReply: true },
      audit: audit(),
    }));

    const upsert = queries().find(isUpsert);
    expect(upsert?.sql).toContain('on conflict ("guild_id","command_key") do update set');
    expect(upsert?.sql).toContain('clock_timestamp()');
    expect(upsert?.sql).not.toContain('now()');
    expect(upsert?.params.slice(0, 9)).toEqual([
      GUILD,
      'ban',
      false,
      'punish',
      null,
      JSON.stringify({ 'add.user': 'Who to punish' }),
      true,
      1,
      ACTOR,
    ]);
  });

  test('the audit row carries the guild and everything the caller gave it', async () => {
    const { store, queries } = storeWith([]);

    await store.write(GUILD, 'ban', () => ({
      next: renamed,
      audit: audit({ id: 'audit-7', ipHash: 'hash' }),
    }));

    const insert = queries().find(isAudit);
    expect(insert?.params).toEqual(
      expect.arrayContaining(['audit-7', GUILD, ACTOR, 'dashboard', 'command.update', 'hash']),
    );
  });

  test('returns the written settings and the guild’s rows with them merged in', async () => {
    const { store } = storeWith(
      [dbRow({ command_key: 'kick', name: 'boot' }), dbRow({ command_key: 'ban' })],
      dbRow({ name: 'punish', updated_at: LATER }),
    );

    const written = await store.write(GUILD, 'ban', () => ({ next: renamed, audit: audit() }));

    expect(written?.settings).toEqual({
      ...DEFAULT_COMMAND_SETTINGS,
      name: 'punish',
      updatedAt: LATER,
    });
    expect(Object.keys(written?.guild ?? {})).toEqual(['kick', 'ban']);
    expect(written?.guild.ban).toEqual(written?.settings);
    expect(written?.guild.kick?.name).toBe('boot');
  });

  test('a decision to write nothing commits without an upsert or an audit row', async () => {
    const { store, steps, queries } = storeWith([dbRow()]);

    expect(await store.write(GUILD, 'ban', () => null)).toBeNull();

    expect(queries().some(isUpsert)).toBe(false);
    expect(queries().some(isAudit)).toBe(false);
    expect(steps.at(-1)).toBe('commit');
  });

  test('a decision that throws rolls back before anything is written', async () => {
    const { store, steps, queries } = storeWith([dbRow()]);

    await expect(
      store.write(GUILD, 'ban', () => {
        throw new Error('command_changed');
      }),
    ).rejects.toThrow('command_changed');

    expect(queries().some(isUpsert)).toBe(false);
    expect(steps.at(-1)).toBe('rollback');
  });

  test('an async decision is awaited inside the transaction', async () => {
    const { store, steps } = storeWith([]);

    await store.write(GUILD, 'ban', async () => {
      await Promise.resolve();
      return { next: renamed, audit: audit() };
    });

    expect(steps.at(-1)).toBe('commit');
    expect(steps.filter((step) => typeof step !== 'string')).toHaveLength(4);
  });

  test('settings that fail the schema are refused and nothing is written', async () => {
    const { store, steps, queries } = storeWith([]);

    await expect(
      store.write(GUILD, 'ban', () => ({
        next: { ...renamed, optionDescriptions: { 'add.user': 5 } } as unknown as CommandSettings,
        audit: audit(),
      })),
    ).rejects.toThrow();

    expect(queries().some(isUpsert)).toBe(false);
    expect(steps.at(-1)).toBe('rollback');
  });
});
