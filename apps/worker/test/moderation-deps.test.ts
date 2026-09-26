import { describe, expect, test } from 'bun:test';
import type { Logger, RestProxyClient, RestRequestOptions } from '@proton/core';
import { PERMISSIONS_MODULE_ID, permissionsConfigSchema } from '@proton/module-permissions';
import { createCommandGate } from '../src/command-gate.ts';
import { createMemberLookup, readMemberLookup } from '../src/member-lookup.ts';
import { createMessageReader, readMessageResponse } from '../src/message-read.ts';
import type { ConfigProvider, ModuleConfigSnapshot } from '../src/runtime.ts';

const GUILD = '900000000000000001';
const USER = '100000000000000001';
const CHANNEL = '500000000000000001';
const MESSAGE = '1400000000000000001';
const ROLE = '700000000000000001';

function restAnswering(status: number, body: unknown) {
  const calls: RestRequestOptions[] = [];
  const rest: RestProxyClient = {
    async request(options) {
      calls.push(options);
      return { status, body };
    },
  };
  return { rest, calls };
}

describe('lookupMember', () => {
  test('reads roles, timeout and join time from a member', async () => {
    const { rest, calls } = restAnswering(200, {
      roles: [ROLE],
      joined_at: '2026-01-02T03:04:05.000Z',
      communication_disabled_until: '2026-09-20T00:00:00.000Z',
      user: { id: USER },
    });

    expect(await createMemberLookup(rest)(GUILD, USER)).toEqual({
      state: 'member',
      roleIds: [ROLE],
      timeoutUntil: Date.parse('2026-09-20T00:00:00.000Z'),
      joinedAt: Date.parse('2026-01-02T03:04:05.000Z'),
    });
    expect(calls).toEqual([{ method: 'GET', path: `/guilds/${GUILD}/members/${USER}` }]);
  });

  test('a member with no timeout has none', () => {
    expect(readMemberLookup(200, { roles: [], joined_at: null })).toEqual({
      state: 'member',
      roleIds: [],
      timeoutUntil: null,
      joinedAt: null,
    });
  });

  test('Discord’s Unknown Member means absent', () => {
    expect(readMemberLookup(404, { code: 10007, message: 'Unknown Member' })).toEqual({
      state: 'absent',
    });
  });

  test('a 502 from the proxy is unavailable, whatever its message says', () => {
    expect(
      readMemberLookup(502, { error: 'rest_proxy_upstream_failure', message: 'Unknown Member' }),
    ).toEqual({ state: 'unavailable', status: 502 });
  });

  test('a 404 that does not prove Unknown Member is unavailable, never absent', () => {
    expect(readMemberLookup(404, '404 Not Found')).toEqual({ state: 'unavailable', status: 404 });
    expect(readMemberLookup(404, { code: 10013, message: 'Unknown User' })).toEqual({
      state: 'unavailable',
      status: 404,
    });
  });

  test('any other failure is unavailable with its status', () => {
    expect(readMemberLookup(403, { code: 50001 })).toEqual({ state: 'unavailable', status: 403 });
    expect(readMemberLookup(500, undefined)).toEqual({ state: 'unavailable', status: 500 });
  });

  test('a proxy that cannot be reached is unavailable, not a thrown handler', async () => {
    const rest: RestProxyClient = {
      request: async () => {
        throw new Error('connection refused');
      },
    };

    expect(await createMemberLookup(rest)(GUILD, USER)).toEqual({
      state: 'unavailable',
      status: 0,
    });
  });
});

describe('readMessage', () => {
  const raw = {
    id: MESSAGE,
    channel_id: CHANNEL,
    content: 'hello',
    timestamp: '2026-08-14T09:01:00.000000+00:00',
    type: 0,
    attachments: [],
    embeds: [],
    author: { id: USER, username: 'tester', bot: false },
  };

  test('reads a message through the rest proxy', async () => {
    const { rest, calls } = restAnswering(200, raw);

    const read = await createMessageReader(rest)(GUILD, CHANNEL, MESSAGE);

    expect(read.ok && read.message.content).toBe('hello');
    expect(calls[0]?.path).toBe(`/channels/${CHANNEL}/messages/${MESSAGE}`);
  });

  test('404 is not found and 403 is no access', () => {
    expect(readMessageResponse(404, { code: 10008 })).toEqual({ ok: false, reason: 'not_found' });
    expect(readMessageResponse(403, { code: 50001 })).toEqual({ ok: false, reason: 'no_access' });
  });

  test('anything else is a failure, never not found', () => {
    expect(readMessageResponse(500, undefined)).toEqual({ ok: false, reason: 'failed' });
    expect(readMessageResponse(200, { nonsense: true })).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('commandGate', () => {
  const silent = (warnings: string[] = []): Logger => ({
    info: () => {},
    warn: (message) => warnings.push(message),
    error: () => {},
  });

  function gate(
    snapshot: ModuleConfigSnapshot | Error,
    registered = true,
    warnings: string[] = [],
  ) {
    const config: ConfigProvider = {
      async get() {
        if (snapshot instanceof Error) throw snapshot;
        return snapshot;
      },
    };

    return createCommandGate({
      registry: { get: (id: string) => (registered ? ({ id } as never) : undefined) },
      config,
      logger: silent(warnings),
    });
  }

  const overridden = permissionsConfigSchema.parse({ overrides: { ban: [ROLE] } });

  test('refuses a member without the role an override asks for, in the override’s words', async () => {
    const answer = await gate({ enabled: true, config: overridden })(GUILD, 'ban', []);

    expect(answer.allowed).toBe(false);
    expect(answer.allowed ? '' : answer.message).toContain('/ban');
  });

  test('allows a member holding the role', async () => {
    expect(await gate({ enabled: true, config: overridden })(GUILD, 'ban', [ROLE])).toEqual({
      allowed: true,
    });
  });

  test('allows everything while the permissions module is off or not shipped', async () => {
    expect(await gate({ enabled: false, config: overridden })(GUILD, 'ban', [])).toEqual({
      allowed: true,
    });
    expect(await gate({ enabled: true, config: overridden }, false)(GUILD, 'ban', [])).toEqual({
      allowed: true,
    });
  });

  test('settings that cannot be read refuse and say so, as the slash command does', async () => {
    const warnings: string[] = [];

    expect(
      await gate(new Error('api returned 503'), true, warnings)(GUILD, 'kick', [ROLE]),
    ).toEqual({
      allowed: false,
      message:
        "I couldn't read this server's Permissions settings, so I couldn't check who can use " +
        '/kick. Nothing was done. Try again in a moment.',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('api returned 503');
  });

  test('names a renamed command the way the server sees it, while the override stays keyed', async () => {
    const config: ConfigProvider = {
      async get(_guildId, moduleId) {
        if (moduleId !== PERMISSIONS_MODULE_ID) throw new Error('unexpected module');
        return { enabled: true, config: overridden };
      },
    };
    const named = createCommandGate({
      registry: { get: (id: string) => ({ id }) as never },
      config,
      logger: silent(),
      displayName: async (_guildId, key) => (key === 'ban' ? 'punish' : key),
    });

    const answer = await named(GUILD, 'ban', []);

    expect(answer.allowed ? '' : answer.message).toContain('/punish');
    expect(answer.allowed ? '' : answer.message).not.toContain('/ban');
    expect(await named(GUILD, 'ban', [ROLE])).toEqual({ allowed: true });
  });

  test('a display name that cannot be read falls back to the key', async () => {
    const unreadable = createCommandGate({
      registry: { get: (id: string) => ({ id }) as never },
      config: {
        async get() {
          throw new Error('api returned 503');
        },
      },
      logger: silent(),
      displayName: async () => {
        throw new Error('database down');
      },
    });

    const answer = await unreadable(GUILD, 'kick', []);

    expect(answer.allowed ? '' : answer.message).toContain('/kick');
  });

  test('settings that are stored but invalid allow with a warning, as the slash command does', async () => {
    const warnings: string[] = [];

    expect(
      await gate({ enabled: true, config: { overrides: 'nope' } }, true, warnings)(
        GUILD,
        'kick',
        [],
      ),
    ).toEqual({ allowed: true });
    expect(warnings).toHaveLength(1);
  });
});

describe('the worker binds what moderation needs', () => {
  // Every field is optional, so leaving one out type-checks and the feature refuses as unbound.
  test.each([
    'guildState',
    'fetchMemberRoles',
    'applicationId',
    'lookupMember',
    'readMessage',
    'commandGate',
    'users',
    'placeholders',
    'drafts',
    'reports',
    'reactionGate',
    'prompts',
    'mailbox',
    'timeouts',
    'ledger',
    'caseMessages',
    'history',
    'dmChannels',
    'reversals',
    'botUserId',
    'dashboardUrl',
  ])('%s', async (key) => {
    const source = await Bun.file(`${import.meta.dir}/../src/index.ts`).text();
    const start = source.indexOf('    moderation: {');
    const block = source.slice(start, source.indexOf('\n    },', start));

    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(new RegExp(`\\n\\s+${key}[:,]`));
  });
});
