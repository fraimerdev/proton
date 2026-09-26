import { afterEach, describe, expect, test } from 'bun:test';
import type { CommandCatalogueView } from '@proton/core';
import { ApiClient, ApiError } from '../src/lib/api-client.ts';
import { COMMAND_CHANGED, isCommandChanged } from '../src/lib/errors.ts';
import { viewOf } from './commands-views.ts';

const GUILD = '900000000000000002';
const ACTOR = '400000000000000001';
const STAMP = { actorId: ACTOR, source: 'dashboard' as const, ipHash: 'abc' };

const realFetch = globalThis.fetch;

let calls: { url: string; init: RequestInit }[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  calls = [];
});

function answer(status: number, body: unknown) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the api client to throw');
}

const api = () => new ApiClient('http://api.test/', 'secret');

const UPDATE = {
  name: 'bonk',
  description: null,
  optionDescriptions: { 'add.user': 'Who to bonk' },
  privateReply: null,
  expectedUpdatedAt: null,
  definitionHash: 'hash-ban',
  ...STAMP,
};

const CATALOGUE: CommandCatalogueView = {
  commands: [viewOf('ban'), viewOf('user:Report user')],
  sync: { state: 'pending', checkedAt: null, syncedAt: null, failure: null },
  lostPermissions: null,
};

describe('ApiClient.getCommands', () => {
  test('reads the catalogue, filling what jsonb left out', async () => {
    const ban = viewOf('ban');
    const { updatedAt: _dropped, ...settings } = ban.settings;
    answer(200, { ...CATALOGUE, commands: [{ ...ban, settings }] });

    const view = await api().getCommands(GUILD);

    expect(calls[0]?.url).toBe(`http://api.test/guilds/${GUILD}/commands`);
    expect(calls[0]?.init.method).toBeUndefined();
    expect(view.commands[0]?.settings.updatedAt).toBeNull();
    expect(view.sync.state).toBe('pending');
  });

  test('a catalogue missing a key is refused by name', async () => {
    answer(200, { commands: [], lostPermissions: null });

    await expect(api().getCommands(GUILD)).rejects.toThrow(/does not understand: sync: /);
  });
});

describe('ApiClient.updateCommand', () => {
  test('puts the draft with the audit stamp to the key’s own path', async () => {
    answer(200, { ok: true, command: viewOf('ban', { settings: { name: 'bonk' } }) });

    const result = await api().updateCommand(GUILD, 'ban', UPDATE);

    expect(calls[0]?.url).toBe(`http://api.test/guilds/${GUILD}/commands/ban`);
    expect(calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(UPDATE);
    expect(new Headers(calls[0]?.init.headers).get('x-proton-secret')).toBe('secret');
    expect(result.ok && result.command.settings.name).toBe('bonk');
  });

  test('encodes a menu key, whose space and colon are not path-safe', async () => {
    answer(200, { ok: true, command: viewOf('user:Report user') });

    await api().updateCommand(GUILD, 'user:Report user', UPDATE);

    expect(calls[0]?.url).toBe(`http://api.test/guilds/${GUILD}/commands/user%3AReport%20user`);
  });

  test('a refused definition comes back as a result carrying each issue', async () => {
    const issues = [
      { path: 'name', message: 'Command names must be lowercase.' },
      {
        path: 'options.add.user',
        message: 'Descriptions can be at most 100 characters (this one is 112).',
      },
    ];
    answer(400, { error: 'invalid_command', message: 'The command was not saved.', issues });

    expect(await api().updateCommand(GUILD, 'ban', UPDATE)).toEqual({ ok: false, issues });
  });

  test('a 400 without issues is still an error, with the api’s sentence', async () => {
    answer(400, { error: 'invalid_command', message: 'Apps menu commands cannot be renamed.' });

    const error = await refusal(() => api().updateCommand(GUILD, 'user:Report user', UPDATE));

    expect(error.status).toBe(400);
    expect(error.issues).toBeUndefined();
    expect(error.message).toBe('Apps menu commands cannot be renamed.');
  });

  test('a conflict is an error the dialog can recognise across the server-function boundary', async () => {
    answer(409, { error: 'command_changed', message: 'Someone else saved /ban.' });

    const error = await refusal(() => api().updateCommand(GUILD, 'ban', UPDATE));

    expect(error.status).toBe(409);
    expect(error.code).toBe('command_changed');
    expect(error.message).toBe(COMMAND_CHANGED);
    expect(isCommandChanged(new Error(error.message))).toBe(true);
    expect(isCommandChanged(new Error('Something else.'))).toBe(false);
  });

  test('an unknown command keeps the api’s own refusal', async () => {
    answer(404, { error: 'unknown_command', message: 'Proton has no command called gone.' });

    const error = await refusal(() => api().updateCommand(GUILD, 'gone', UPDATE));

    expect(error.code).toBe('unknown_command');
    expect(error.message).toBe('Proton has no command called gone.');
  });
});

describe('ApiClient.setCommandEnabled', () => {
  test('posts the switch with the stamp and returns the command as saved', async () => {
    answer(200, { command: viewOf('ban', { settings: { enabled: false } }) });

    const command = await api().setCommandEnabled(GUILD, 'message:Punish author', {
      enabled: false,
      ...STAMP,
    });

    expect(calls[0]?.url).toBe(
      `http://api.test/guilds/${GUILD}/commands/message%3APunish%20author/enabled`,
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ enabled: false, ...STAMP });
    expect(command.settings.enabled).toBe(false);
  });
});

describe('ApiClient.ackLostCommandPermissions', () => {
  test('posts the stamp to the acknowledgement path', async () => {
    answer(200, { ok: true });

    await api().ackLostCommandPermissions(GUILD, STAMP);

    expect(calls[0]?.url).toBe(`http://api.test/guilds/${GUILD}/commands/lost-permissions/ack`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(STAMP);
  });
});

describe('ApiError', () => {
  test('keeps well-formed issues from any refusal and ignores malformed ones', async () => {
    answer(422, { error: 'x', message: 'No.', issues: [{ path: 'name', message: 'Bad.' }] });
    expect((await refusal(() => api().getCommands(GUILD))).issues).toEqual([
      { path: 'name', message: 'Bad.' },
    ]);

    answer(422, { error: 'x', message: 'No.', issues: [{ where: 'name' }] });
    expect((await refusal(() => api().getCommands(GUILD))).issues).toBeUndefined();
  });
});
