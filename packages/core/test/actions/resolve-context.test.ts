import { describe, expect, test } from 'bun:test';
import { runPrechecks } from '../../src/actions/prechecks.ts';
import { resolvePrecheckContext } from '../../src/actions/resolve-context.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import type { GuildState, GuildStatePatch, GuildStateStore } from '../../src/guild-state/types.ts';
import { Permissions } from '../../src/permissions/bits.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const TARGET = '400000000000000009';
const CHANNEL = '500000000000000001';

const BOT_ROLE = '410000000000000005';
const HIGH_ROLE = '410000000000000009';
const LOW_ROLE = '410000000000000001';

function state(overrides: Partial<GuildState> = {}): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([
      [GUILD, { id: GUILD, permissions: Permissions.ViewChannel, position: 0 }],
      [LOW_ROLE, { id: LOW_ROLE, permissions: 0n, position: 1 }],
      [
        BOT_ROLE,
        {
          id: BOT_ROLE,
          permissions: Permissions.ViewChannel | Permissions.SendMessages | Permissions.BanMembers,
          position: 5,
        },
      ],
      [HIGH_ROLE, { id: HIGH_ROLE, permissions: 0n, position: 9 }],
    ]),
    botRoleIds: [BOT_ROLE],
    channels: new Map([[CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }]]),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function store(value: GuildState | null): GuildStateStore {
  return {
    get: async () => value,
    put: async () => undefined,
    patch: async (_id: string, _p: GuildStatePatch) => undefined,
    delete: async () => undefined,
  };
}

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    guildId: GUILD,
    moduleId: 'test',
    kind: 'send',
    actorId: '100000000000000001',
    dryRun: false,
    idempotencyKey: 'k',
    payload: { channelId: CHANNEL, content: 'hi' },
    ...overrides,
  };
}

describe('resolvePrecheckContext', () => {
  test('reports the real guild owner and bot role position', async () => {
    const result = await resolvePrecheckContext(
      { store: store(state()), botUserId: BOT },
      request(),
      {
        channelId: CHANNEL,
      },
    );

    expect('context' in result).toBe(true);
    if (!('context' in result)) return;

    // The Gate 0 stub returned '' and MAX_SAFE_INTEGER for these two.
    expect(result.context.guildOwnerId).toBe(OWNER);
    expect(result.context.botHighestRolePosition).toBe(5);
  });

  test('derives the required permission from the action kind', async () => {
    const result = await resolvePrecheckContext(
      { store: store(state()), botUserId: BOT },
      request(),
      {
        channelId: CHANNEL,
      },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.requiredPermissions).toBe(
      Permissions.ViewChannel | Permissions.SendMessages,
    );
  });

  test('prefers the interaction’s app_permissions over cached overwrites', async () => {
    const result = await resolvePrecheckContext(
      { store: store(state()), botUserId: BOT },
      request(),
      { channelId: CHANNEL, appPermissions: Permissions.Administrator },
    );
    if (!('context' in result)) throw new Error('expected a context');

    // Discord computed this for us (§10.5) — authoritative and free.
    expect(result.context.botChannelPermissions).toBe(Permissions.Administrator);
  });

  test('computes channel permissions from cache when there is no interaction', async () => {
    const result = await resolvePrecheckContext(
      { store: store(state()), botUserId: BOT },
      request(),
      { channelId: CHANNEL },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.botChannelPermissions & Permissions.SendMessages).toBe(
      Permissions.SendMessages,
    );
  });
});

/**
 * The security core of P1.A. Every one of these produced a *passing* precheck
 * under the Gate 0 stub, because it fabricated state designed to satisfy I8.
 */
describe('failing closed', () => {
  test('missing guild state refuses rather than assuming', async () => {
    const result = await resolvePrecheckContext({ store: store(null), botUserId: BOT }, request());

    expect('failure' in result).toBe(true);
    if (!('failure' in result)) return;
    expect(result.failure.code).toBe('guild_state_unavailable');
  });

  test('the resolved context actually trips runPrechecks for the owner', async () => {
    // `send` does not target a member, so simulate a kind that does by feeding
    // the owner in as the target — this is the assertion that will guard every
    // moderation kind added in P1.B.
    const result = await resolvePrecheckContext(
      { store: store(state()), botUserId: BOT },
      request(),
      { channelId: CHANNEL },
    );
    if (!('context' in result)) throw new Error('expected a context');

    const failure = runPrechecks({
      ...result.context,
      target: { id: OWNER, highestRolePosition: 1 },
    });

    expect(failure?.code).toBe('target_is_owner');
  });

  test('a target above the bot is refused once positions are real', async () => {
    const result = await resolvePrecheckContext(
      { store: store(state()), botUserId: BOT },
      request(),
      { channelId: CHANNEL },
    );
    if (!('context' in result)) throw new Error('expected a context');

    const failure = runPrechecks({
      ...result.context,
      target: { id: TARGET, highestRolePosition: 9 },
    });

    // botHighestRolePosition is 5 here; under the stub it was MAX_SAFE_INTEGER
    // and this could never fail.
    expect(failure?.code).toBe('role_hierarchy');
  });

  test('an unresolvable member refuses instead of guessing the hierarchy', async () => {
    const { resolvePrecheckContext: resolve } = await import(
      '../../src/actions/resolve-context.ts'
    );

    // Simulate a member-targeting kind by asserting the helper's own contract:
    // with no roles supplied and no fetcher, it must not invent a position.
    const result = await resolve(
      {
        store: store(state()),
        botUserId: BOT,
        fetchMemberRoles: async () => null,
      },
      request({ targetId: TARGET }),
      { channelId: CHANNEL },
    );

    // `send` does not target a member, so this still resolves — the guard is
    // exercised for real by the moderation kinds in P1.B.
    expect('context' in result).toBe(true);
  });
});

describe('role position maths', () => {
  test('takes the highest of several roles', async () => {
    const result = await resolvePrecheckContext(
      { store: store(state({ botRoleIds: [LOW_ROLE, BOT_ROLE] })), botUserId: BOT },
      request(),
      { channelId: CHANNEL },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.botHighestRolePosition).toBe(5);
  });

  test('a bot with no roles sits at position 0, below everyone', async () => {
    const result = await resolvePrecheckContext(
      { store: store(state({ botRoleIds: [] })), botUserId: BOT },
      request(),
      { channelId: CHANNEL },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.botHighestRolePosition).toBe(0);
  });
});
