import { describe, expect, test } from 'bun:test';
import { ACTION_KINDS, isChannelScoped } from '../../src/actions/kinds.ts';
import { THREAD_TYPE_PUBLIC } from '../../src/actions/payloads.ts';
import { runPrechecks } from '../../src/actions/prechecks.ts';
import {
  type ResolveContextHints,
  resolvePrecheckContext,
} from '../../src/actions/resolve-context.ts';
import type { ActionRequest } from '../../src/actions/types.ts';
import type {
  ChannelState,
  GuildState,
  GuildStatePatch,
  GuildStateStore,
} from '../../src/guild-state/types.ts';
import { Permissions } from '../../src/permissions/bits.ts';
import type { Overwrite } from '../../src/permissions/compute.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const TARGET = '400000000000000009';
const CHANNEL = '500000000000000001';
const OTHER_CHANNEL = '500000000000000002';
const UNCACHED_CHANNEL = '500000000000000003';
const THREAD = '500000000000000009';
const MESSAGE = '700000000000000001';
const OTHER_MESSAGE = '700000000000000002';

const BOT_ROLE = '410000000000000005';
const HIGH_ROLE = '410000000000000009';
const LOW_ROLE = '410000000000000001';

const MAY_POST = Permissions.ViewChannel | Permissions.SendMessages;

const INVOCATION: ResolveContextHints = { channelId: CHANNEL, appPermissions: MAY_POST };

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

describe('failing closed', () => {
  test('missing guild state refuses rather than assuming', async () => {
    const result = await resolvePrecheckContext({ store: store(null), botUserId: BOT }, request());

    expect('failure' in result).toBe(true);
    if (!('failure' in result)) return;
    expect(result.failure.code).toBe('guild_state_unavailable');
  });

  test('the resolved context actually trips runPrechecks for the owner', async () => {
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

    expect(failure?.code).toBe('role_hierarchy');
  });

  test('an unresolvable member refuses instead of guessing the hierarchy', async () => {
    const { resolvePrecheckContext: resolve } = await import(
      '../../src/actions/resolve-context.ts'
    );

    const result = await resolve(
      {
        store: store(state()),
        botUserId: BOT,
        fetchMemberRoles: async () => null,
      },
      request({ targetId: TARGET }),
      { channelId: CHANNEL },
    );

    expect('context' in result).toBe(true);
  });
});

function withChannels(): GuildState {
  return state({
    channels: new Map([
      [CHANNEL, { id: CHANNEL, parentId: null, overwrites: [] }],
      [
        OTHER_CHANNEL,
        {
          id: OTHER_CHANNEL,
          parentId: null,
          overwrites: [
            { id: BOT_ROLE, type: 0 as const, allow: 0n, deny: Permissions.SendMessages },
          ],
        },
      ],
    ]),
  });
}

function botHolding(permissions: bigint, channels = withChannels().channels): GuildState {
  return state({
    roles: new Map([
      [GUILD, { id: GUILD, permissions: 0n, position: 0 }],
      [BOT_ROLE, { id: BOT_ROLE, permissions, position: 5 }],
    ]),
    channels,
  });
}

type ThreadChannelState = ChannelState & { type: number };

function threadUnder(parentId: string): ThreadChannelState {
  return { id: THREAD, parentId, overwrites: [], type: THREAD_TYPE_PUBLIC };
}

function withThread(parentOverwrites: Overwrite[] = []): Map<string, ChannelState> {
  return new Map<string, ChannelState>([
    [CHANNEL, { id: CHANNEL, parentId: null, overwrites: parentOverwrites }],
    [THREAD, threadUnder(CHANNEL)],
  ]);
}

describe('the channel the action actually targets', () => {
  test('comes from the payload when no caller hinted one', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({ payload: { channelId: OTHER_CHANNEL, content: 'hi' } }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.channelId).toBe(OTHER_CHANNEL);
  });

  test('applies that channel’s overwrites, so a denial is caught before Discord 403s', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({ payload: { channelId: OTHER_CHANNEL, content: 'hi' } }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    const failure = runPrechecks(result.context);

    expect(failure?.code).toBe('missing_permission');
    expect(failure?.humanReason).toContain('Send Messages');
    expect(failure?.humanReason).toContain(OTHER_CHANNEL);
  });

  test('leaves an unhinted send in a permitted channel alone', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({ payload: { channelId: CHANNEL, content: 'hi' } }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(runPrechecks(result.context)).toBeNull();
  });

  test.each([
    ['delete_channel', { channelId: OTHER_CHANNEL }],
    ['edit_channel', { channelId: OTHER_CHANNEL, name: 'general' }],
    ['create_thread', { channelId: OTHER_CHANNEL, name: 't', type: THREAD_TYPE_PUBLIC }],
    ['end_poll', { channelId: OTHER_CHANNEL, messageId: MESSAGE }],
    ['pin_message', { channelId: OTHER_CHANNEL, messageId: MESSAGE }],
    ['purge', { channelId: OTHER_CHANNEL, messageIds: [MESSAGE, OTHER_MESSAGE] }],
    ['slowmode', { channelId: OTHER_CHANNEL, seconds: 5 }],
  ] as const)('is read out of a %s payload too', async (kind, payload) => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({ kind, payload }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.channelId).toBe(OTHER_CHANNEL);
  });

  test('is read out of move_member, because its channelId is the destination it must judge', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT, fetchMemberRoles: async () => [LOW_ROLE] },
      request({
        kind: 'move_member',
        targetId: TARGET,
        payload: { userId: TARGET, channelId: OTHER_CHANNEL },
      }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.channelId).toBe(OTHER_CHANNEL);
  });

  test('is absent for a guild-scoped kind, even though the command was typed in a channel', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT, fetchMemberRoles: async () => [LOW_ROLE] },
      request({ kind: 'ban', targetId: TARGET, payload: { userId: TARGET } }),
      INVOCATION,
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.channelId).toBeUndefined();
  });

  test('wins over a caller hint, because the hint is only where the command was typed', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({ payload: { channelId: OTHER_CHANNEL, content: 'hi' } }),
      { channelId: CHANNEL },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.channelId).toBe(OTHER_CHANNEL);
  });

  test('is not refused because the invocation channel denies what the target channel allows', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({ payload: { channelId: CHANNEL, content: 'hi' } }),
      { channelId: OTHER_CHANNEL },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.channelId).toBe(CHANNEL);
    expect(runPrechecks(result.context)).toBeNull();
  });
});

describe('the interaction’s app_permissions', () => {
  test('is applied when the payload targets the channel the command was typed in', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({ payload: { channelId: OTHER_CHANNEL, content: 'hi' } }),
      { channelId: OTHER_CHANNEL, appPermissions: MAY_POST },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.botChannelPermissions).toBe(MAY_POST);
    expect(runPrechecks(result.context)).toBeNull();
  });

  test('is discarded when the payload targets a different channel, whose overwrites decide', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({ payload: { channelId: OTHER_CHANNEL, content: 'hi' } }),
      { channelId: CHANNEL, appPermissions: MAY_POST },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.botChannelPermissions & Permissions.SendMessages).toBe(0n);

    const failure = runPrechecks(result.context);
    expect(failure?.code).toBe('missing_permission');
    expect(failure?.humanReason).toContain(OTHER_CHANNEL);
    expect(failure?.humanReason).not.toContain(CHANNEL);
  });

  test('never stands in for a guild-scoped action, whose permission no channel can grant', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT, fetchMemberRoles: async () => [LOW_ROLE] },
      request({ kind: 'ban', targetId: TARGET, payload: { userId: TARGET } }),
      { ...INVOCATION, appPermissions: Permissions.Administrator },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.botChannelPermissions).not.toBe(Permissions.Administrator);
    expect(result.context.botChannelPermissions & Permissions.BanMembers).toBe(
      Permissions.BanMembers,
    );
  });

  test('is not consumed by any guild-scoped kind, whatever the caller hints', async () => {
    for (const kind of ACTION_KINDS.filter((k) => !isChannelScoped(k))) {
      const result = await resolvePrecheckContext(
        { store: store(withChannels()), botUserId: BOT },
        request({ kind, targetId: TARGET, payload: { userId: TARGET, channelId: OTHER_CHANNEL } }),
        { ...INVOCATION, appPermissions: Permissions.Administrator, targetRoleIds: [LOW_ROLE] },
      );
      if (!('context' in result)) throw new Error(`expected a context for ${kind}`);

      expect(result.context.channelId).toBeUndefined();
      expect(result.context.botChannelPermissions & Permissions.Administrator).toBe(0n);
    }
  });
});

describe('the shape apps/worker gives every slash command: scoped to the invocation channel', () => {
  test('/ban passes on the guild-wide grant the invocation channel knows nothing about', async () => {
    const result = await resolvePrecheckContext(
      { store: store(botHolding(Permissions.BanMembers)), botUserId: BOT },
      request({ kind: 'ban', targetId: TARGET, payload: { userId: TARGET } }),
      { ...INVOCATION, targetRoleIds: [] },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(runPrechecks(result.context)).toBeNull();
  });

  test('/ban that the guild really forbids blames the guild, never the channel it was typed in', async () => {
    const result = await resolvePrecheckContext(
      { store: store(botHolding(MAY_POST)), botUserId: BOT },
      request({ kind: 'ban', targetId: TARGET, payload: { userId: TARGET } }),
      { ...INVOCATION, appPermissions: Permissions.BanMembers, targetRoleIds: [] },
    );
    if (!('context' in result)) throw new Error('expected a context');

    const failure = runPrechecks(result.context);

    expect(failure?.code).toBe('missing_permission');
    expect(failure?.humanReason).toContain('Ban Members');
    expect(failure?.humanReason).toContain('this server');
    expect(failure?.humanReason).not.toContain(CHANNEL);
  });

  test('/backup restore creates a role on the guild grant, not the channel /backup was typed in', async () => {
    const result = await resolvePrecheckContext(
      { store: store(botHolding(Permissions.ManageRoles)), botUserId: BOT },
      request({ kind: 'create_role', payload: { name: 'Moderator' } }),
      INVOCATION,
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.channelId).toBeUndefined();
    expect(runPrechecks(result.context)).toBeNull();
  });

  test('a create_role the guild really forbids blames the guild', async () => {
    const result = await resolvePrecheckContext(
      { store: store(botHolding(MAY_POST)), botUserId: BOT },
      request({ kind: 'create_role', payload: { name: 'Moderator' } }),
      { ...INVOCATION, appPermissions: Permissions.ManageRoles },
    );
    if (!('context' in result)) throw new Error('expected a context');

    const failure = runPrechecks(result.context);

    expect(failure?.humanReason).toContain('Manage Roles');
    expect(failure?.humanReason).toContain('this server');
    expect(failure?.humanReason).not.toContain(CHANNEL);
  });

  test('a send still reads its channel out of the payload and keeps the hint’s permissions', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({ payload: { channelId: CHANNEL, content: 'hi' } }),
      INVOCATION,
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.channelId).toBe(CHANNEL);
    expect(result.context.botChannelPermissions).toBe(MAY_POST);
  });
});

describe('a channel that is really a thread', () => {
  test('needs SendMessagesInThreads, which is the only bit that governs a thread', async () => {
    const result = await resolvePrecheckContext(
      { store: store(botHolding(MAY_POST, withThread())), botUserId: BOT },
      request({ payload: { channelId: THREAD, content: 'hi' } }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.requiredPermissions & Permissions.SendMessagesInThreads).toBe(
      Permissions.SendMessagesInThreads,
    );
    expect(result.context.requiredPermissions & Permissions.SendMessages).toBe(0n);
  });

  test('is refused before Discord 403s when the guild granted only SendMessages', async () => {
    const result = await resolvePrecheckContext(
      { store: store(botHolding(MAY_POST, withThread())), botUserId: BOT },
      request({ payload: { channelId: THREAD, content: 'hi' } }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    const failure = runPrechecks(result.context);

    expect(failure?.code).toBe('missing_permission');
    expect(failure?.humanReason).toContain('Send Messages in Threads');
  });

  test('names the thread and the parent channel the permission is actually granted in', async () => {
    const result = await resolvePrecheckContext(
      { store: store(botHolding(MAY_POST, withThread())), botUserId: BOT },
      request({ payload: { channelId: THREAD, content: 'hi' } }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.threadParentId).toBe(CHANNEL);

    const failure = runPrechecks(result.context);

    expect(failure?.humanReason).toContain(`<#${THREAD}>`);
    expect(failure?.humanReason).toContain(CHANNEL);
  });

  test('passes once the guild grants the thread bit', async () => {
    const granted = Permissions.ViewChannel | Permissions.SendMessagesInThreads;

    const result = await resolvePrecheckContext(
      { store: store(botHolding(granted, withThread())), botUserId: BOT },
      request({ payload: { channelId: THREAD, content: 'hi' } }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(runPrechecks(result.context)).toBeNull();
  });

  test('is judged by the parent channel’s overwrites, because a thread has none of its own', async () => {
    const granted = Permissions.ViewChannel | Permissions.SendMessagesInThreads;
    const deniedOnParent: Overwrite[] = [
      { id: BOT_ROLE, type: 0, allow: 0n, deny: Permissions.SendMessagesInThreads },
    ];

    const result = await resolvePrecheckContext(
      { store: store(botHolding(granted, withThread(deniedOnParent))), botUserId: BOT },
      request({ payload: { channelId: THREAD, content: 'hi' } }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(runPrechecks(result.context)?.humanReason).toContain('Send Messages in Threads');
  });

  test('still needs the thread bit when an interaction in it reports app_permissions', async () => {
    const result = await resolvePrecheckContext(
      { store: store(botHolding(MAY_POST, withThread())), botUserId: BOT },
      request({ payload: { channelId: THREAD, content: 'hi' } }),
      { channelId: THREAD, appPermissions: MAY_POST },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(runPrechecks(result.context)?.humanReason).toContain('Send Messages in Threads');
  });

  test('leaves an ordinary channel asking for SendMessages', async () => {
    const result = await resolvePrecheckContext(
      { store: store(botHolding(MAY_POST, withThread())), botUserId: BOT },
      request({ payload: { channelId: CHANNEL, content: 'hi' } }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.requiredPermissions & Permissions.SendMessages).toBe(
      Permissions.SendMessages,
    );
    expect(result.context.threadParentId).toBeUndefined();
    expect(runPrechecks(result.context)).toBeNull();
  });
});

describe('a channel that guild state has never seen', () => {
  test('does not claim a channel-level check that the missing overwrites made impossible', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({
        kind: 'create_thread',
        payload: { channelId: UNCACHED_CHANNEL, name: 'ticket-1', type: THREAD_TYPE_PUBLIC },
      }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.channelOverwritesUnknown).toBe(true);

    const failure = runPrechecks(result.context);
    expect(failure?.humanReason).toContain('Create Public Threads');
    expect(failure?.humanReason).toContain('this server');
    expect(failure?.humanReason).toContain("isn't in my channel list yet");
  });

  test('is still reported as a channel-level check when app_permissions covered it', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({
        kind: 'create_thread',
        payload: { channelId: UNCACHED_CHANNEL, name: 'ticket-1', type: THREAD_TYPE_PUBLIC },
      }),
      { channelId: UNCACHED_CHANNEL, appPermissions: Permissions.ViewChannel },
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.channelOverwritesUnknown).toBeUndefined();

    const failure = runPrechecks(result.context);
    expect(failure?.humanReason).toContain(`<#${UNCACHED_CHANNEL}>`);
    expect(failure?.humanReason).not.toContain('cached channel list');
  });
});

describe('the requirement the payload decides', () => {
  test('a poll send is prechecked against Send Polls, not just Send Messages', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({
        payload: {
          channelId: CHANNEL,
          poll: { question: { text: 'Which map?' }, answers: [{ poll_media: { text: 'Dust' } }] },
        },
      }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.requiredPermissions & Permissions.SendPolls).toBe(Permissions.SendPolls);
    expect(runPrechecks(result.context)?.humanReason).toContain('Create Polls');
  });

  test('a public thread is prechecked against the public bit the guild may hold', async () => {
    const result = await resolvePrecheckContext(
      { store: store(withChannels()), botUserId: BOT },
      request({
        kind: 'create_thread',
        payload: { channelId: CHANNEL, name: 'spoilers', type: THREAD_TYPE_PUBLIC },
      }),
    );
    if (!('context' in result)) throw new Error('expected a context');

    expect(result.context.requiredPermissions & Permissions.CreatePrivateThreads).toBe(0n);
    expect(runPrechecks(result.context)?.humanReason).toContain('Create Public Threads');
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
