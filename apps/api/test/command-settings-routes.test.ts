import { describe, expect, test } from 'bun:test';
import {
  commandCatalogue,
  commandCatalogueViewSchema,
  commandIssueSchema,
  commandUpdateResultSchema,
  commandViewSchema,
  commandWorkerViewSchema,
  definitionHash,
} from '@proton/core';
import { z } from 'zod';
import type { ApiDeps } from '../src/app.ts';
import { createApiApp } from '../src/app.ts';
import {
  ADMIN,
  type CommandHarness,
  commandHarness,
  GUILD,
  OTHER_GUILD,
  registration,
} from './command-fixtures.ts';

const SECRET = 'shared-secret-for-tests';
const MENU = 'user:Report user';

function appFor(h: CommandHarness, present: readonly string[] = [GUILD]) {
  const deps = {
    commands: h.service,
    guilds: {
      presence: (ids: readonly string[]) =>
        Promise.resolve({ present: ids.filter((id) => present.includes(id)), known: true }),
    },
    registry: h.registry,
    logger: { warn: () => undefined },
    sharedSecret: SECRET,
  } as unknown as ApiDeps;

  return createApiApp(deps);
}

function send(
  app: ReturnType<typeof createApiApp>,
  method: string,
  path: string,
  body?: unknown,
  secret: string | null = SECRET,
) {
  return app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-proton-secret': secret }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function hashOf(h: CommandHarness, key: string): Promise<string> {
  const entry = commandCatalogue(h.registry).find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`no ${key}`);
  return definitionHash(entry.data);
}

async function updateBody(h: CommandHarness, key: string, overrides: Record<string, unknown> = {}) {
  return {
    name: null,
    description: null,
    optionDescriptions: {},
    privateReply: null,
    expectedUpdatedAt: null,
    definitionHash: await hashOf(h, key),
    actorId: ADMIN,
    source: 'dashboard',
    ...overrides,
  };
}

const errorSchema = z.object({ error: z.string(), message: z.string() });

describe('the commands routes', () => {
  test('GET /guilds/:g/commands answers the catalogue view', async () => {
    const h = commandHarness();
    const response = await send(appFor(h), 'GET', `/guilds/${GUILD}/commands`);

    expect(response.status).toBe(200);
    const view = commandCatalogueViewSchema.parse(await response.json());
    expect(view.commands.map((command) => command.key)).toContain(MENU);
    expect(view.sync.state).toBe('unsynced');
  });

  test('GET /guilds/:g/commands/worker-view answers the worker view', async () => {
    const h = commandHarness();
    h.settings.seed(GUILD, 'warn', { name: 'caution' });

    const response = await send(appFor(h), 'GET', `/guilds/${GUILD}/commands/worker-view`);

    expect(response.status).toBe(200);
    const view = commandWorkerViewSchema.parse(await response.json());
    expect(view.settings.warn?.name).toBe('caution');
    expect(view.modulesOn.moderation).toBe(true);
  });

  test('PUT saves and answers ok with the command as the catalogue shows it', async () => {
    const h = commandHarness();
    const response = await send(
      appFor(h),
      'PUT',
      `/guilds/${GUILD}/commands/warn`,
      await updateBody(h, 'warn', { name: 'caution' }),
    );

    expect(response.status).toBe(200);
    const result = commandUpdateResultSchema.parse(await response.json());
    expect(result).toMatchObject({ ok: true, command: { key: 'warn', effectiveName: 'caution' } });
  });

  test('PUT answers 400 invalid_command with the issues when Discord would refuse it', async () => {
    const h = commandHarness();
    const response = await send(
      appFor(h),
      'PUT',
      `/guilds/${GUILD}/commands/warn`,
      await updateBody(h, 'warn', { name: 'two words' }),
    );

    expect(response.status).toBe(400);
    const parsed = errorSchema
      .extend({ issues: z.array(commandIssueSchema) })
      .parse(await response.json());
    expect(parsed.error).toBe('invalid_command');
    expect(parsed.issues).toEqual([
      {
        path: 'name',
        message: 'Command names can only use letters, numbers, - and _, with no spaces.',
      },
    ]);
    expect(parsed.message).toContain('Command names can only use letters');
    expect(h.settings.audits).toEqual([]);
  });

  test('PUT on a context menu refuses its customization once per field, said once', async () => {
    const h = commandHarness();
    const response = await send(
      appFor(h),
      'PUT',
      `/guilds/${GUILD}/commands/${encodeURIComponent(MENU)}`,
      await updateBody(h, MENU, { name: 'report', description: 'Report someone.' }),
    );

    expect(response.status).toBe(400);
    const parsed = errorSchema
      .extend({ issues: z.array(commandIssueSchema) })
      .parse(await response.json());
    expect(parsed.issues.map((issue) => issue.path)).toEqual(['name', 'description']);
    expect(parsed.message.split('Apps menu entry')).toHaveLength(2);
  });

  test('PUT answers 409 command_changed for a stale page', async () => {
    const h = commandHarness();
    h.settings.seed(GUILD, 'warn', { name: 'alert' });

    const response = await send(
      appFor(h),
      'PUT',
      `/guilds/${GUILD}/commands/warn`,
      await updateBody(h, 'warn', { name: 'caution' }),
    );

    expect(response.status).toBe(409);
    expect(errorSchema.parse(await response.json()).error).toBe('command_changed');
  });

  test('PUT answers 404 for a command Proton does not have', async () => {
    const h = commandHarness();
    const response = await send(
      appFor(h),
      'PUT',
      `/guilds/${GUILD}/commands/nope`,
      await updateBody(h, 'warn'),
    );

    expect(response.status).toBe(404);
    expect(errorSchema.parse(await response.json()).error).toBe('unknown_command');
  });

  test('PUT refuses a body without the audit stamp', async () => {
    const h = commandHarness();
    const { actorId: _actorId, ...unstamped } = await updateBody(h, 'warn');

    const response = await send(appFor(h), 'PUT', `/guilds/${GUILD}/commands/warn`, unstamped);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_body' });
  });

  test('POST enabled answers the command, reading a percent-encoded menu key', async () => {
    const h = commandHarness();
    const response = await send(
      appFor(h),
      'POST',
      `/guilds/${GUILD}/commands/${encodeURIComponent(MENU)}/enabled`,
      { enabled: false, actorId: ADMIN, source: 'dashboard' },
    );

    expect(response.status).toBe(200);
    const { command } = z.object({ command: commandViewSchema }).parse(await response.json());
    expect(command).toMatchObject({ key: MENU, settings: { enabled: false } });
    expect(h.settings.audits[0]?.after).toEqual({ key: MENU, enabled: false });
  });

  test('POST lost-permissions/ack answers ok', async () => {
    const h = commandHarness();
    h.registrations.set(
      registration({
        lostPermissions: {
          commands: [{ key: 'ban', name: 'ban' }],
          at: '2026-09-22T08:00:00.000Z',
        },
      }),
    );

    const response = await send(
      appFor(h),
      'POST',
      `/guilds/${GUILD}/commands/lost-permissions/ack`,
      { actorId: ADMIN, source: 'dashboard' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(h.registrations.audits.map((audit) => audit.action)).toEqual([
      'command.permissions_ack',
    ]);
  });
});

describe('the guards in front of the commands routes', () => {
  test('every route needs the shared secret', async () => {
    const h = commandHarness();
    const app = appFor(h);

    const responses = await Promise.all([
      send(app, 'GET', `/guilds/${GUILD}/commands`, undefined, null),
      send(app, 'GET', `/guilds/${GUILD}/commands/worker-view`, undefined, 'wrong-secret-value'),
      send(app, 'PUT', `/guilds/${GUILD}/commands/warn`, await updateBody(h, 'warn'), null),
      send(app, 'POST', `/guilds/${GUILD}/commands/warn/enabled`, { enabled: false }, null),
      send(app, 'POST', `/guilds/${GUILD}/commands/lost-permissions/ack`, {}, null),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    expect(h.settings.audits).toEqual([]);
  });

  test('a write for a server Proton is not in is refused and nothing is saved', async () => {
    const h = commandHarness();
    const app = appFor(h, []);

    const responses = await Promise.all([
      send(app, 'PUT', `/guilds/${OTHER_GUILD}/commands/warn`, await updateBody(h, 'warn')),
      send(app, 'POST', `/guilds/${OTHER_GUILD}/commands/warn/enabled`, {
        enabled: false,
        actorId: ADMIN,
        source: 'dashboard',
      }),
      send(app, 'POST', `/guilds/${OTHER_GUILD}/commands/lost-permissions/ack`, {
        actorId: ADMIN,
        source: 'dashboard',
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([409, 409, 409]);
    for (const response of responses) {
      expect(await response.json()).toMatchObject({ error: 'bot_absent' });
    }
    expect(h.settings.audits).toEqual([]);
  });

  test('the page still loads for a server Proton is not in', async () => {
    const response = await send(
      appFor(commandHarness(), []),
      'GET',
      `/guilds/${OTHER_GUILD}/commands`,
    );

    expect(response.status).toBe(200);
  });
});
