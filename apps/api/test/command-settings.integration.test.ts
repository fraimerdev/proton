import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  type CommandUpdateBody,
  commandCatalogue,
  commandCatalogueViewSchema,
  commandSetHash,
  definitionHash,
  effectiveCommandSet,
} from '@proton/core';
import {
  createDb,
  type DbHandle,
  DrizzleCommandRegistrationStore,
  DrizzleCommandSettingsStore,
  runMigrations,
} from '@proton/db';
import { auditTrail, guildCommands, guildModules, guilds } from '@proton/db/schema';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { CommandSettingsService } from '../src/commands/service.ts';
import { ModuleConfigService } from '../src/modules/service.ts';
import { ADMIN, GUILD, RecordingBus, testRegistry } from './command-fixtures.ts';

let container: StartedPostgreSqlContainer;
let handle: DbHandle;
let service: CommandSettingsService;
let registrations: DrizzleCommandRegistrationStore;

const registry = testRegistry();
const bus = new RecordingBus();

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  handle = createDb(container.getConnectionUri());
  await runMigrations(handle);

  registrations = new DrizzleCommandRegistrationStore(handle);
  service = new CommandSettingsService({
    registry,
    settings: new DrizzleCommandSettingsStore(handle),
    registrations,
    modules: new ModuleConfigService(handle, registry),
    scope: { scope: 'every-guild', testGuildId: null },
    bus,
  });
}, 240_000);

afterAll(async () => {
  await handle?.close();
  await container?.stop();
}, 240_000);

beforeEach(async () => {
  bus.published.length = 0;
  await handle.client`delete from guilds`;
  await handle.db.insert(guilds).values({ id: GUILD, name: 'test guild' });
  await handle.db.insert(guildModules).values({
    guildId: GUILD,
    moduleId: 'moderation',
    enabled: true,
    config: { enabled: true, publicReplies: false },
  });
});

async function body(key: string, overrides: Partial<CommandUpdateBody> = {}) {
  const entry = commandCatalogue(registry).find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`no ${key}`);

  return {
    name: null,
    description: null,
    optionDescriptions: {},
    privateReply: null,
    expectedUpdatedAt: null,
    definitionHash: await definitionHash(entry.data),
    actorId: ADMIN,
    source: 'dashboard' as const,
    ...overrides,
  };
}

async function expectedHash(): Promise<string> {
  const view = await service.workerView(GUILD);

  return commandSetHash(
    effectiveCommandSet({
      catalogue: commandCatalogue(registry),
      modulesOn: view.modulesOn,
      settings: view.settings,
    }).commands,
  );
}

describe('saving against Postgres', () => {
  test('the row and its audit entry land together', async () => {
    const result = await service.update(GUILD, 'ban', await body('ban', { name: 'punish' }));
    expect(result.ok).toBe(true);

    const [row] = await handle.db
      .select()
      .from(guildCommands)
      .where(eq(guildCommands.guildId, GUILD));
    expect(row).toMatchObject({
      commandKey: 'ban',
      name: 'punish',
      enabled: true,
      updatedBy: ADMIN,
    });

    const audits = await handle.db.select().from(auditTrail).where(eq(auditTrail.guildId, GUILD));
    expect(audits.map((audit) => audit.action)).toEqual(['command.update']);
    expect(audits[0]?.after).toMatchObject({ key: 'ban', settings: { name: 'punish' } });
    expect(bus.published[0]?.payload).toMatchObject({ auditId: audits[0]?.id, newName: 'punish' });
  });

  test('two renames to the same free name at once: one saves, the other is told why', async () => {
    const [warn, kick] = await Promise.all([
      service.update(GUILD, 'warn', await body('warn', { name: 'caution' })),
      service.update(GUILD, 'kick', await body('kick', { name: 'caution' })),
    ]);

    const outcomes = [warn, kick];
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);

    const refused = outcomes.find((result) => !result.ok);
    expect(refused && !refused.ok ? refused.issues.map((issue) => issue.path) : []).toEqual([
      'name',
    ]);

    const rows = await handle.db
      .select()
      .from(guildCommands)
      .where(eq(guildCommands.guildId, GUILD));
    expect(rows.filter((row) => row.name === 'caution')).toHaveLength(1);
  });

  test('a save made against a stale time is refused and the stored row is kept', async () => {
    const first = await service.update(GUILD, 'warn', await body('warn', { name: 'alert' }));
    if (!first.ok) throw new Error('the first save was refused');

    await service.update(
      GUILD,
      'warn',
      await body('warn', { name: 'caution', expectedUpdatedAt: first.command.settings.updatedAt }),
    );

    await expect(
      service.update(
        GUILD,
        'warn',
        await body('warn', { name: 'mine', expectedUpdatedAt: first.command.settings.updatedAt }),
      ),
    ).rejects.toMatchObject({ code: 'command_changed' });

    const [row] = await handle.db
      .select()
      .from(guildCommands)
      .where(eq(guildCommands.guildId, GUILD));
    expect(row?.name).toBe('caution');
  });

  test('a saved name Proton is not using survives a save of the reply preference alone', async () => {
    await handle.db
      .insert(guildCommands)
      .values({ guildId: GUILD, commandKey: 'tag', name: 'kick' });
    const tag = (await service.catalogue(GUILD)).commands.find((command) => command.key === 'tag');
    expect(tag).toMatchObject({ effectiveName: 'tag', refused: false });

    const result = await service.update(
      GUILD,
      'tag',
      await body('tag', {
        name: tag?.effectiveName ?? null,
        privateReply: true,
        expectedUpdatedAt: tag?.settings.updatedAt ?? null,
      }),
    );
    expect(result.ok).toBe(true);

    const [row] = await handle.db
      .select()
      .from(guildCommands)
      .where(eq(guildCommands.guildId, GUILD));
    expect(row).toMatchObject({ commandKey: 'tag', name: 'kick', privateReply: true });
    expect(bus.published[0]?.payload).toMatchObject({
      changed: ['privateReply'],
      registration: false,
    });
  });

  test('a refused customization is flagged, and fixing it brings its saved name back', async () => {
    await handle.db.insert(guildCommands).values({
      guildId: GUILD,
      commandKey: 'warn',
      name: 'caution',
      description: 'd'.repeat(150),
    });
    const warn = (await service.catalogue(GUILD)).commands.find(
      (command) => command.key === 'warn',
    );
    expect(warn).toMatchObject({ effectiveName: 'warn', refused: true });

    const result = await service.update(
      GUILD,
      'warn',
      await body('warn', {
        name: warn?.effectiveName ?? null,
        description: 'Give a member a caution.',
        expectedUpdatedAt: warn?.settings.updatedAt ?? null,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      command: { effectiveName: 'caution', refused: false, ignored: null },
    });
  });

  test('reset clears overrides for options the code has since removed', async () => {
    await handle.db.insert(guildCommands).values({
      guildId: GUILD,
      commandKey: 'warn',
      name: 'caution',
      optionDescriptions: { 'gone.option': 'Still here.' },
    });
    const warn = (await service.catalogue(GUILD)).commands.find(
      (command) => command.key === 'warn',
    );

    await service.update(
      GUILD,
      'warn',
      await body('warn', { expectedUpdatedAt: warn?.settings.updatedAt ?? null }),
    );

    const [row] = await handle.db
      .select()
      .from(guildCommands)
      .where(eq(guildCommands.guildId, GUILD));
    expect(row?.name).toBeNull();
    expect(row?.optionDescriptions).toEqual({});
  });

  test('the switch leaves the customization alone and is audited as its own action', async () => {
    await service.update(GUILD, 'warn', await body('warn', { name: 'caution' }));
    await service.setEnabled(GUILD, 'warn', {
      enabled: false,
      actorId: ADMIN,
      source: 'dashboard',
    });

    const [row] = await handle.db
      .select()
      .from(guildCommands)
      .where(eq(guildCommands.guildId, GUILD));
    expect(row).toMatchObject({ enabled: false, name: 'caution' });

    const audits = await handle.db.select().from(auditTrail).where(eq(auditTrail.guildId, GUILD));
    expect(audits.map((audit) => audit.action).sort()).toEqual([
      'command.enabled',
      'command.update',
    ]);
  });
});

describe('the sync state against Postgres', () => {
  test('pending after a save, synced once the worker records the new hash', async () => {
    await registrations.recordSuccess(GUILD, {
      scope: 'every-guild',
      hash: await expectedHash(),
      commands: [],
    });
    expect((await service.catalogue(GUILD)).sync.state).toBe('synced');

    await service.update(GUILD, 'warn', await body('warn', { name: 'caution' }));
    expect((await service.catalogue(GUILD)).sync.state).toBe('pending');

    await registrations.recordSuccess(GUILD, {
      scope: 'every-guild',
      hash: await expectedHash(),
      commands: [],
    });
    expect((await service.catalogue(GUILD)).sync.state).toBe('synced');
  });

  test('the lost-permissions banner is dismissed once, with its audit row', async () => {
    await registrations.recordPermissions(GUILD, {
      scope: 'every-guild',
      lost: [{ key: 'ban', name: 'ban' }],
      at: '2026-09-22T08:00:00.000Z',
    });
    expect((await service.catalogue(GUILD)).lostPermissions?.commands).toEqual([
      { key: 'ban', name: 'ban' },
    ]);

    await service.ackLostPermissions(GUILD, { actorId: ADMIN, source: 'dashboard' });
    await service.ackLostPermissions(GUILD, { actorId: ADMIN, source: 'dashboard' });

    expect((await service.catalogue(GUILD)).lostPermissions).toBeNull();
    const audits = await handle.db.select().from(auditTrail).where(eq(auditTrail.guildId, GUILD));
    expect(audits.map((audit) => audit.action)).toEqual(['command.permissions_ack']);
  });
});

describe('module state against Postgres', () => {
  test('an unreadable module config does not break the catalogue or the worker view', async () => {
    await handle.db.insert(guildModules).values({
      guildId: GUILD,
      moduleId: 'tags',
      enabled: true,
      config: { enabled: 'yes', ephemeral: 3 },
    });

    const view = commandCatalogueViewSchema.parse(await service.catalogue(GUILD));
    expect(view.commands.find((command) => command.key === 'tag')?.reply?.paths).toEqual([
      { path: '', default: 'public', toggleable: true },
    ]);
    expect((await service.workerView(GUILD)).modulesOn.tags).toBe(true);
  });

  test('a module whose own enabled field is off is off in the worker view', async () => {
    await handle.db
      .update(guildModules)
      .set({ config: { enabled: false, publicReplies: false } })
      .where(eq(guildModules.guildId, GUILD));

    expect((await service.workerView(GUILD)).modulesOn.moderation).toBe(false);
  });
});
