import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { type ModuleManifest, ModuleRegistry, type ProtonEvent } from '@proton/core';
import {
  collectConfigTemplates,
  definePlaceholderSurface,
  lookupFrom,
  type ModuleTemplates,
  userDefinitions,
  placeholderValue as v,
  withAliases,
} from '@proton/core/placeholders';
import { createDb, type DbHandle, runMigrations } from '@proton/db';
import { guildModules, guilds } from '@proton/db/schema';
import { pingModule } from '@proton/module-ping';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
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

  test('refuses a stored config that no longer satisfies the schema', async () => {
    await handle.db.insert(guildModules).values({
      guildId: GUILD,
      moduleId: 'ping',
      enabled: true,
      config: { enabled: true, response: '', restrictToChannel: null },
      schemaVersion: 1,
    });

    await expect(service.get(GUILD, 'ping')).rejects.toThrow(/could not read this server/);
  });

  test('fills in defaults for fields added since the row was written', async () => {
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

    expect(entry?.before.enabled).toBe(false);
    expect(entry?.after.enabled).toBe(true);
    expect(entry?.after.config.response).toBe('First');

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

describe('a save from a dashboard page loaded before the last deploy', () => {
  test('a lift is handed the config being replaced, so a key the page never sent survives', async () => {
    const carrying: typeof pingModule = {
      ...pingModule,
      liftStoredConfig: (raw, current) =>
        current !== undefined && typeof raw === 'object' && raw !== null && !('response' in raw)
          ? { ...raw, response: current.response }
          : raw,
    };

    const registry = new ModuleRegistry();
    registry.register(carrying);
    const modules = new ModuleConfigService(handle, registry);

    await modules.update({
      guildId: GUILD,
      moduleId: 'ping',
      enabled: true,
      config: { enabled: true, response: 'Kept', restrictToChannel: null },
      actorId: ACTOR,
      source: 'dashboard',
    });

    const { after } = await modules.update({
      guildId: GUILD,
      moduleId: 'ping',
      config: { enabled: true, restrictToChannel: null },
      actorId: ACTOR,
      source: 'dashboard',
    });

    expect(after.config.response).toBe('Kept');
  });
});

describe('placeholder templates on save', () => {
  const REPLY = definePlaceholderSurface<null>({
    id: 'ping.reply',
    module: 'ping',
    label: 'Ping reply',
    event: 'ping.reply',
    audience: 'public',
    fields: [{ path: 'response', kind: 'discord_text', label: 'Reply text', limit: 2000 }],
    definitions: [
      ...userDefinitions('user', { member: false }).map((definition) =>
        definition.key === 'user.mention' ? withAliases(definition, ['user']) : definition,
      ),
      {
        key: 'user.staff_note',
        label: 'Staff note',
        group: 'Member',
        type: 'text',
        example: v.text('watch them'),
        sensitivity: 'staff_only',
      },
    ],
    build: () => lookupFrom({}),
    samples: [],
  });

  const templates: ModuleTemplates = {
    surfaces: { [REPLY.id]: REPLY },
    collect: (config) => collectConfigTemplates(config, REPLY),
  };

  let modules: ModuleConfigService;

  beforeEach(() => {
    const templated: typeof pingModule = { ...pingModule, templates };
    const registry = new ModuleRegistry();
    registry.register(templated);
    modules = new ModuleConfigService(handle, registry);
  });

  async function store(response: string) {
    await handle.db.insert(guildModules).values({
      guildId: GUILD,
      moduleId: 'ping',
      enabled: true,
      config: { enabled: true, response, restrictToChannel: null },
      schemaVersion: 1,
    });
  }

  async function auditRows(): Promise<number> {
    const rows = await handle.client`select count(*)::int as n from audit_trail`;
    return (rows as unknown as Array<{ n: number }>)[0]?.n ?? -1;
  }

  test('a changed broken placeholder is refused, naming the field, and nothing is written', async () => {
    await store('Pong!');

    const error = await modules
      .update({
        guildId: GUILD,
        moduleId: 'ping',
        config: { enabled: true, response: 'Pong {user.staff_note}', restrictToChannel: null },
        actorId: ACTOR,
        source: 'dashboard',
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ModuleConfigError);
    expect(error instanceof ModuleConfigError ? error.code : null).toBe('invalid_template');
    expect(error instanceof ModuleConfigError ? error.message : '').toStartWith(
      'Those Ping settings were not saved: response Reply text: ',
    );

    expect((await modules.get(GUILD, 'ping')).config.response).toBe('Pong!');
    expect(await auditRows()).toBe(0);
  });

  test('a stored reply that no longer validates is still read, and the switch still saves it', async () => {
    await store('Pong {user:shout}');

    expect((await modules.get(GUILD, 'ping')).config.response).toBe('Pong {user:shout}');

    const { after } = await modules.update({
      guildId: GUILD,
      moduleId: 'ping',
      enabled: false,
      actorId: ACTOR,
      source: 'dashboard',
    });

    expect(after.enabled).toBe(false);
    expect(after.config.response).toBe('Pong {user:shout}');

    const view = await modules.get(GUILD, 'ping');
    expect(view.enabled).toBe(false);
    expect(view.config.response).toBe('Pong {user:shout}');
    expect(await auditRows()).toBe(1);
  });

  test('a change that only warns is saved', async () => {
    const { after } = await modules.update({
      guildId: GUILD,
      moduleId: 'ping',
      enabled: true,
      config: { enabled: true, response: 'Pong {nobody}', restrictToChannel: null },
      actorId: ACTOR,
      source: 'dashboard',
    });

    expect(after.config.response).toBe('Pong {nobody}');
    expect((await modules.get(GUILD, 'ping')).config.response).toBe('Pong {nobody}');
  });

  test('the first save of a server is judged against the defaults', async () => {
    await expect(
      modules.update({
        guildId: GUILD,
        moduleId: 'ping',
        enabled: true,
        config: { enabled: true, response: '{user.staff_note}', restrictToChannel: null },
        actorId: ACTOR,
        source: 'dashboard',
      }),
    ).rejects.toThrow(/not saved: response Reply text: /);

    const rows = await handle.client`select count(*)::int as n from guild_modules`;
    expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
  });
});

describe('asking Proton to post a panel', () => {
  const PANELS = 'panels';

  const panelConfigSchema = z.object({
    enabled: z.boolean().default(true),
    channelId: z.string().nullable().default(null),
  });

  const panelModule: ModuleManifest<typeof panelConfigSchema> = {
    id: PANELS,
    name: 'Panels',
    category: 'utility',
    configSchema: panelConfigSchema,
    defaultConfig: { enabled: true, channelId: null },
    schemaVersion: 1,
    requiredIntents: [],
    requiredPermissions: [],
    postables: (config) => [
      { id: 'panel', name: 'The panel', channelId: config.channelId ?? undefined },
    ],
  };

  let published: ProtonEvent[];
  let panels: ModuleConfigService;

  beforeEach(async () => {
    published = [];

    const registry = new ModuleRegistry();
    registry.register(pingModule);
    registry.register(panelModule);

    panels = new ModuleConfigService(handle, registry, {
      bus: {
        publish: async (e) => {
          published.push(e);
        },
        subscribe: () => ({ group: 'test', close: async () => {} }),
      },
    });

    await handle.db.insert(guildModules).values({
      guildId: GUILD,
      moduleId: PANELS,
      enabled: true,
      config: { enabled: true, channelId: '700000000000000001' },
      schemaVersion: 1,
    });
  });

  async function ask(panelId = 'panel') {
    return panels.requestPanel({
      guildId: GUILD,
      moduleId: PANELS,
      panelId,
      actorId: ACTOR,
      source: 'dashboard',
    });
  }

  test('publishes the request and names the panel back', async () => {
    const answer = await ask();

    expect(answer.name).toBe('The panel');
    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe('proton.panel_requested');
    expect(published[0]?.payload).toMatchObject({
      auditId: answer.auditId,
      guildId: GUILD,
      moduleId: PANELS,
      panelId: 'panel',
      actorId: ACTOR,
    });
  });

  test('writes an audit row whoever pressed the button can be traced by', async () => {
    const answer = await ask();

    const rows = (await handle.client`
      select id, actor_id, action, after from audit_trail where id = ${answer.auditId}
    `) as unknown as Array<{ actor_id: string; action: string; after: { name: string } }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_id).toBe(ACTOR);
    expect(rows[0]?.action).toBe(`module.${PANELS}.panel.post`);
    expect(rows[0]?.after.name).toBe('The panel');
  });

  test('refuses a module that keeps nothing in a channel', async () => {
    await expect(
      panels.requestPanel({
        guildId: GUILD,
        moduleId: 'ping',
        panelId: 'panel',
        actorId: ACTOR,
        source: 'dashboard',
      }),
    ).rejects.toThrow(/nothing Proton posts/);
  });

  test('refuses to post for a module that is switched off', async () => {
    await handle.db
      .update(guildModules)
      .set({ enabled: false })
      .where(and(eq(guildModules.guildId, GUILD), eq(guildModules.moduleId, PANELS)));

    await expect(ask()).rejects.toThrow(/switched off/);
    expect(published).toHaveLength(0);
  });

  test('refuses a panel id the config no longer has', async () => {
    await expect(ask('renamed-since-the-page-loaded')).rejects.toThrow(/may have been renamed/);
    expect(published).toHaveLength(0);
  });

  test('refuses a panel with no channel yet rather than publishing a request nobody can serve', async () => {
    await handle.db
      .update(guildModules)
      .set({ config: { enabled: true, channelId: null } })
      .where(and(eq(guildModules.guildId, GUILD), eq(guildModules.moduleId, PANELS)));

    await expect(ask()).rejects.toThrow(/no channel to go in/);
    expect(published).toHaveLength(0);
  });

  test('says so when there is no bus, instead of reporting a send that never happened', async () => {
    const registry = new ModuleRegistry();
    registry.register(panelModule);

    const busless = new ModuleConfigService(handle, registry);

    await expect(
      busless.requestPanel({
        guildId: GUILD,
        moduleId: PANELS,
        panelId: 'panel',
        actorId: ACTOR,
        source: 'dashboard',
      }),
    ).rejects.toThrow(/cannot reach its event bus/);

    const rows = await handle.client`select count(*)::int as n from audit_trail`;
    expect((rows as unknown as Array<{ n: number }>)[0]?.n).toBe(0);
  });
});
