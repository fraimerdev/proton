import { describe, expect, test } from 'bun:test';
import { commandCatalogueViewSchema } from '@proton/core';
import { CommandSettingsService } from '../src/commands/service.ts';
import { ModuleConfigService } from '../src/modules/service.ts';
import {
  GUILD,
  MemoryCommandSettingsStore,
  MemoryRegistrationStore,
  testRegistry,
} from './command-fixtures.ts';
import { fakePostgres, pick } from './fake-postgres.ts';

function modulesWith(rows: Array<{ module_id: string; enabled: boolean; config: unknown }>) {
  const registry = testRegistry();
  const { handle, queries } = fakePostgres((query) =>
    query.sql.includes('from "guild_modules"') ? rows.map((row) => pick(query, row)) : [],
  );

  return { registry, queries, modules: new ModuleConfigService(handle, registry) };
}

describe('module states for the Commands page', () => {
  test('a module with no row is off with its defaults', async () => {
    const { modules } = modulesWith([]);

    expect((await modules.moduleStates(GUILD)).tags).toEqual({
      on: false,
      config: { enabled: true, ephemeral: false },
    });
  });

  test('a module is off when its own enabled field is, whatever its row says', async () => {
    const { modules } = modulesWith([
      { module_id: 'tags', enabled: true, config: { enabled: false, ephemeral: true } },
      { module_id: 'moderation', enabled: true, config: { enabled: true, publicReplies: true } },
    ]);

    const states = await modules.moduleStates(GUILD);

    expect(states.tags).toEqual({ on: false, config: { enabled: false, ephemeral: true } });
    expect(states.moderation).toEqual({
      on: true,
      config: { enabled: true, publicReplies: true },
    });
  });

  test('an unreadable config keeps the row’s switch and reads as the module defaults', async () => {
    const { modules } = modulesWith([
      { module_id: 'tags', enabled: true, config: { enabled: 'yes', ephemeral: 3 } },
    ]);

    expect((await modules.moduleStates(GUILD)).tags).toEqual({
      on: true,
      config: { enabled: true, ephemeral: false },
    });
  });

  test('reads the guild’s rows once, scoped to the guild', async () => {
    const { modules, queries } = modulesWith([]);

    await modules.moduleStates(GUILD);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.params).toEqual([GUILD]);
  });

  test('one module with an unreadable config does not take the Commands page down', async () => {
    const { registry, modules } = modulesWith([
      { module_id: 'tags', enabled: true, config: { enabled: 'yes', ephemeral: 3 } },
      { module_id: 'moderation', enabled: true, config: { enabled: true, publicReplies: true } },
    ]);

    const service = new CommandSettingsService({
      registry,
      settings: new MemoryCommandSettingsStore(),
      registrations: new MemoryRegistrationStore(),
      modules,
      scope: { scope: 'every-guild', testGuildId: null },
    });

    const view = commandCatalogueViewSchema.parse(await service.catalogue(GUILD));
    const tag = view.commands.find((command) => command.key === 'tag');
    const warn = view.commands.find((command) => command.key === 'warn');

    expect(tag?.moduleOn).toBe(true);
    expect(tag?.reply?.paths).toEqual([{ path: '', default: 'public', toggleable: true }]);
    expect(warn?.reply?.paths).toEqual([{ path: '', default: 'public', toggleable: true }]);
  });
});

describe('a module save, as the command sync sweep compares it', () => {
  test('stamps updated_at with the database clock, never this host’s', async () => {
    const { handle, queries } = fakePostgres();
    Object.assign(handle.db, {
      transaction: (run: (tx: typeof handle.db) => Promise<unknown>) => run(handle.db),
    });
    const modules = new ModuleConfigService(handle, testRegistry());

    await modules.update({
      guildId: GUILD,
      moduleId: 'tags',
      enabled: true,
      actorId: '100000000000000001',
      source: 'dashboard',
    });

    const upsert = queries.find((query) => query.sql.startsWith('insert into "guild_modules"'));
    expect(upsert?.sql).toMatch(/values \(.*clock_timestamp\(\)\) on conflict/);
    expect(upsert?.sql).toMatch(/"updated_at" = clock_timestamp\(\)/);
    expect(upsert?.params.some((param) => param instanceof Date)).toBe(false);
    expect(upsert?.params.some((param) => typeof param === 'string' && /^\d{4}-/.test(param))).toBe(
      false,
    );
  });
});
