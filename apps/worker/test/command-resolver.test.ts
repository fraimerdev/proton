import { describe, expect, test } from 'bun:test';
import { commandCatalogue } from '@proton/core';
import type { CommandRegistrationRecord } from '@proton/db';
import { dispatch } from '@proton/fixtures';
import { normalise } from '@proton/gateway/normaliser';
import { CommandResolver, fitsDefinition } from '../src/command-resolver.ts';
import { collectingLogger, commandRegistry, STRING, TEST_GUILD, USER } from './command-fakes.ts';

const BAN_ID = '1260000000000000001';
const KICK_ID = '1260000000000000011';
const WARN_ID = '1260000000000000012';
const TIMEOUT_ID = '1260000000000000013';

function record(overrides: Partial<CommandRegistrationRecord> = {}): CommandRegistrationRecord {
  return {
    guildId: TEST_GUILD,
    scope: 'guild',
    definitionHash: 'h',
    commands: [
      { key: 'ban', id: BAN_ID, name: 'ban', kind: 'chat' },
      { key: 'kick', id: KICK_ID, name: 'kick', kind: 'chat' },
    ],
    idHistory: { [BAN_ID]: 'ban', [KICK_ID]: 'kick', [WARN_ID]: 'warn', [TIMEOUT_ID]: 'timeout' },
    checkedAt: '2026-09-21T00:00:00.000Z',
    syncedAt: '2026-09-21T00:00:00.000Z',
    failure: null,
    permissionsCheckedAt: null,
    lostPermissions: null,
    ...overrides,
  };
}

function resolverWith(reads: Array<CommandRegistrationRecord | null | Error>): {
  resolver: CommandResolver;
  reconciled: string[];
  refreshes: () => number;
} {
  const reconciled: string[] = [];
  let refreshes = 0;
  let cached: CommandRegistrationRecord | null | undefined;

  const next = async () => {
    const value = reads.length > 1 ? reads.shift() : reads[0];
    if (value instanceof Error) throw value;
    cached = value ?? null;
    return cached;
  };

  const resolver = new CommandResolver({
    catalogue: commandCatalogue(commandRegistry()),
    records: {
      get: async () => (cached === undefined ? next() : cached),
      refresh: async () => {
        refreshes += 1;
        return next();
      },
    },
    reconcile: (guildId) => reconciled.push(guildId),
    logger: collectingLogger().logger,
  });

  return { resolver, reconciled, refreshes: () => refreshes };
}

function guildBan(edit: (data: Record<string, unknown>) => void = () => undefined) {
  const event = normalise(dispatch('interactionCreateGuildCommand'))[0];
  if (!event) throw new Error('fixture did not normalise');
  const d = event.payload as Record<string, unknown>;
  edit(d.data as Record<string, unknown>);
  return d;
}

const banAdd = [
  {
    name: 'add',
    type: 1,
    options: [
      { name: 'user', type: USER, value: '100000000000000003' },
      { name: 'reason', type: STRING, value: 'spam' },
    ],
  },
];

describe('CommandResolver.resolve', () => {
  test('a global command (no data.guild_id) resolves by its code name', async () => {
    const { resolver } = resolverWith([record({ idHistory: {} })]);
    const event = normalise(dispatch('interactionCreatePing'))[0];

    expect(await resolver.resolve(TEST_GUILD, event?.payload as Record<string, unknown>)).toEqual({
      key: 'ping',
      displayName: 'ping',
    });
  });

  test('a renamed command resolves by its id to the internal key and keeps the name shown', async () => {
    const { resolver } = resolverWith([record()]);

    const resolved = await resolver.resolve(
      TEST_GUILD,
      guildBan((data) => {
        data.name = 'punish';
      }),
    );

    expect(resolved).toEqual({ key: 'ban', displayName: 'punish' });
  });

  test('a name swap follows the ids, never the names', async () => {
    const { resolver } = resolverWith([record()]);

    const asKick = await resolver.resolve(
      TEST_GUILD,
      guildBan((data) => {
        data.name = 'kick';
      }),
    );

    expect(asKick).toEqual({ key: 'ban', displayName: 'kick' });
  });

  test('warn and timeout share a shape, so only the id tells them apart', async () => {
    const { resolver } = resolverWith([record()]);

    const resolved = await resolver.resolve(
      TEST_GUILD,
      guildBan((data) => {
        data.id = WARN_ID;
        data.name = 'timeout';
      }),
    );

    expect(resolved).toEqual({ key: 'warn', displayName: 'timeout' });
  });

  test('an old id kept in the history still resolves', async () => {
    const { resolver } = resolverWith([record({ commands: [] })]);

    expect(await resolver.resolve(TEST_GUILD, guildBan())).toEqual({
      key: 'ban',
      displayName: 'ban',
    });
  });

  test('an id missing from the cached record re-reads it once', async () => {
    const stale = record({ idHistory: {} });
    const { resolver, refreshes } = resolverWith([stale, record()]);

    expect(await resolver.resolve(TEST_GUILD, guildBan())).toEqual({
      key: 'ban',
      displayName: 'ban',
    });
    expect(refreshes()).toBe(1);
  });

  test('a guild never synced resolves by code name, since it only ever held code names', async () => {
    const { resolver, reconciled } = resolverWith([null]);

    expect(await resolver.resolve(TEST_GUILD, guildBan())).toEqual({
      key: 'ban',
      displayName: 'ban',
    });
    expect(reconciled).toEqual([]);
  });

  test('a guild whose first registration failed still resolves by code name', async () => {
    const failed = record({
      definitionHash: null,
      commands: [],
      idHistory: {},
      checkedAt: '2026-09-21T00:00:00.000Z',
      syncedAt: null,
      failure: {
        code: '50001',
        status: 403,
        message: "Proton can't manage commands in this server.",
        detail: 'Missing Access (code 50001)',
        at: '2026-09-21T00:00:00.000Z',
        retryAt: null,
        hash: 'h',
      },
    });
    const { resolver, reconciled } = resolverWith([failed]);

    expect(await resolver.resolve(TEST_GUILD, guildBan())).toEqual({
      key: 'ban',
      displayName: 'ban',
    });
    expect(reconciled).toEqual([]);
  });

  test.each([
    ['timed out', null],
    ['failed upstream', 502],
    ['was answered in a shape Proton could not read', 200],
  ])('an unknown id is refused while a first PUT that %s may have landed', async (_, status) => {
    const unknown = record({
      definitionHash: null,
      commands: [],
      idHistory: {},
      syncedAt: null,
      failure: {
        code: null,
        status,
        message: 'm',
        detail: 'd',
        at: '2026-09-21T00:00:00.000Z',
        retryAt: '2026-09-21T00:00:05.000Z',
        hash: 'h',
      },
    });
    const { resolver, reconciled } = resolverWith([unknown]);

    expect(await resolver.resolve(TEST_GUILD, guildBan())).toEqual({ unresolved: 'updating' });
    expect(reconciled).toEqual([TEST_GUILD]);
  });

  test('a record with ids but no recorded sync routes by id and refuses the rest', async () => {
    const pending = record({ syncedAt: null, failure: null, definitionHash: null });
    const { resolver } = resolverWith([pending]);

    expect(
      await resolver.resolve(
        TEST_GUILD,
        guildBan((data) => (data.name = 'x')),
      ),
    ).toEqual({
      key: 'ban',
      displayName: 'x',
    });
    expect(
      await resolver.resolve(
        TEST_GUILD,
        guildBan((data) => {
          data.id = '1260000000000000099';
        }),
      ),
    ).toEqual({ unresolved: 'updating' });
  });

  test('an unknown id in a synced guild is refused and triggers a forced reconcile', async () => {
    const { resolver, reconciled } = resolverWith([record({ idHistory: {} })]);

    expect(await resolver.resolve(TEST_GUILD, guildBan())).toEqual({ unresolved: 'updating' });
    expect(reconciled).toEqual([TEST_GUILD]);
  });

  test('a record that cannot be read is refused rather than guessed', async () => {
    const { resolver, reconciled } = resolverWith([new Error('database unreachable')]);

    expect(await resolver.resolve(TEST_GUILD, guildBan())).toEqual({ unresolved: 'updating' });
    expect(reconciled).toEqual([]);
  });

  test('options the code definition does not have are refused as drift', async () => {
    const { resolver, reconciled } = resolverWith([record()]);

    const extra = await resolver.resolve(
      TEST_GUILD,
      guildBan((data) => {
        data.options = [
          { name: 'add', type: 1, options: [{ name: 'days', type: STRING, value: '7' }] },
        ];
      }),
    );
    const retyped = await resolver.resolve(
      TEST_GUILD,
      guildBan((data) => {
        data.options = [
          { name: 'add', type: 1, options: [{ name: 'user', type: STRING, value: 'x' }] },
        ];
      }),
    );
    const flat = await resolver.resolve(
      TEST_GUILD,
      guildBan((data) => {
        data.options = [{ name: 'user', type: USER, value: '100000000000000003' }];
      }),
    );

    expect([extra, retyped, flat]).toEqual([
      { unresolved: 'updating' },
      { unresolved: 'updating' },
      { unresolved: 'updating' },
    ]);
    expect(reconciled).toHaveLength(3);
  });

  test('a stale global copy in a synced guild is pointed at the guild copy, with no reconcile', async () => {
    const { resolver, reconciled } = resolverWith([record()]);
    const global = guildBan((data) => {
      delete data.guild_id;
      data.options = [
        { name: 'add', type: 1, options: [{ name: 'days', type: STRING, value: '7' }] },
      ];
    });

    const outdated = { unresolved: 'outdated', current: 'ban' } as const;
    expect(await resolver.resolve(TEST_GUILD, global)).toEqual(outdated);
    expect(await resolver.resolve(TEST_GUILD, global)).toEqual(outdated);
    expect(reconciled).toEqual([]);
  });

  test('a stale global copy names what the server calls its own copy, or that it has none', async () => {
    const stale = (data: Record<string, unknown>) => {
      delete data.guild_id;
      data.options = [
        { name: 'add', type: 1, options: [{ name: 'days', type: STRING, value: '7' }] },
      ];
    };
    const renamed = resolverWith([
      record({ commands: [{ key: 'ban', id: BAN_ID, name: 'punish', kind: 'chat' }] }),
    ]);
    const switchedOff = resolverWith([
      record({ commands: [{ key: 'kick', id: KICK_ID, name: 'kick', kind: 'chat' }] }),
    ]);

    expect(await renamed.resolver.resolve(TEST_GUILD, guildBan(stale))).toEqual({
      unresolved: 'outdated',
      current: 'punish',
    });
    expect(await switchedOff.resolver.resolve(TEST_GUILD, guildBan(stale))).toEqual({
      unresolved: 'outdated',
      current: null,
    });
    expect([...renamed.reconciled, ...switchedOff.reconciled]).toEqual([]);
  });

  test('a stale global copy before the guild has its own still registers it', async () => {
    const { resolver, reconciled } = resolverWith([null]);
    const global = guildBan((data) => {
      delete data.guild_id;
      data.options = [
        { name: 'add', type: 1, options: [{ name: 'days', type: STRING, value: '7' }] },
      ];
    });

    expect(await resolver.resolve(TEST_GUILD, global)).toEqual({ unresolved: 'updating' });
    expect(reconciled).toEqual([TEST_GUILD]);
  });

  test('a well-formed global copy still resolves by its code name', async () => {
    const { resolver, reconciled } = resolverWith([record()]);
    const global = guildBan((data) => {
      delete data.guild_id;
      data.options = banAdd;
    });

    expect(await resolver.resolve(TEST_GUILD, global)).toEqual({ key: 'ban', displayName: 'ban' });
    expect(reconciled).toEqual([]);
  });

  test('an id recorded for one kind invoked as another is drift', async () => {
    const { resolver } = resolverWith([record()]);
    const event = normalise(dispatch('interactionCreateGuildUserCommand'))[0];
    const d = event?.payload as Record<string, unknown>;
    (d.data as Record<string, unknown>).id = BAN_ID;

    expect(await resolver.resolve(TEST_GUILD, d)).toEqual({ unresolved: 'updating' });
  });

  test('context menus resolve to their type-qualified key', async () => {
    const { resolver } = resolverWith([null]);
    const user = normalise(dispatch('interactionCreateGuildUserCommand'))[0];
    const message = normalise(dispatch('interactionCreateGuildMessageCommand'))[0];

    expect(await resolver.resolve(TEST_GUILD, user?.payload as Record<string, unknown>)).toEqual({
      key: 'user:Report user',
      displayName: 'Report user',
    });
    expect(await resolver.resolve(TEST_GUILD, message?.payload as Record<string, unknown>)).toEqual(
      { key: 'message:Punish author', displayName: 'Punish author' },
    );
  });

  test('an autocomplete interaction resolves the same way', async () => {
    const { resolver } = resolverWith([record()]);
    const event = normalise(dispatch('interactionCreateGuildAutocomplete'))[0];
    const d = event?.payload as Record<string, unknown>;
    (d.data as Record<string, unknown>).name = 'punish';

    expect(await resolver.resolve(TEST_GUILD, d)).toEqual({ key: 'ban', displayName: 'punish' });
  });
});

describe('CommandResolver.displayName', () => {
  test('names a command the way this guild registered it', async () => {
    const { resolver } = resolverWith([
      record({ commands: [{ key: 'ban', id: BAN_ID, name: 'punish', kind: 'chat' }] }),
    ]);

    expect(await resolver.displayName(TEST_GUILD, 'ban')).toBe('punish');
    expect(await resolver.displayName(TEST_GUILD, 'kick')).toBe('kick');
  });

  test('falls back to the key when the record cannot be read', async () => {
    const { resolver } = resolverWith([new Error('down')]);

    expect(await resolver.displayName(TEST_GUILD, 'ban')).toBe('ban');
  });
});

describe('fitsDefinition', () => {
  const ban = commandCatalogue(commandRegistry()).find((entry) => entry.key === 'ban');
  if (ban?.kind !== 'chat') throw new Error('ban is missing');

  test('a well-formed invocation fits', () => {
    expect(fitsDefinition(ban.data, banAdd)).toBe(true);
  });

  test('an unknown subcommand does not', () => {
    expect(fitsDefinition(ban.data, [{ name: 'purge', type: 1, options: [] }])).toBe(false);
  });
});
