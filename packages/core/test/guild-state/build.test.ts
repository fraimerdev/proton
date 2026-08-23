import { describe, expect, test } from 'bun:test';
import { buildGuildState, parseChannel } from '../../src/guild-state/build.ts';
import { CHANNEL_TYPES, isThreadChannel } from '../../src/guild-state/channel-types.ts';
import { Permissions } from '../../src/permissions/bits.ts';
import { computeChannelPermissions } from '../../src/permissions/compute.ts';

const GUILD = '900000000000000001';
const OWNER = '200000000000000001';
const BOT = '300000000000000001';
const BOT_ROLE = '410000000000000005';
const SUPPORT = '500000000000000001';
const GENERAL = '500000000000000002';
const THREAD = '600000000000000001';
const ARCHIVE_CATEGORY = '500000000000000009';

interface GuildCreateOptions {
  channels?: unknown[];
  threads?: unknown[];
  botPermissions?: bigint;
}

function guildCreate(options: GuildCreateOptions = {}): Record<string, unknown> {
  return {
    id: GUILD,
    name: 'Proton Test Guild',
    owner_id: OWNER,
    member_count: 3,
    roles: [
      { id: GUILD, permissions: String(Permissions.ViewChannel), position: 0 },
      {
        id: BOT_ROLE,
        permissions: String(options.botPermissions ?? Permissions.ViewChannel),
        position: 5,
        managed: true,
      },
    ],
    channels: options.channels ?? [
      { id: SUPPORT, type: CHANNEL_TYPES.guildText, parent_id: null, permission_overwrites: [] },
    ],
    ...(options.threads ? { threads: options.threads } : {}),
    members: [{ user: { id: BOT }, roles: [BOT_ROLE] }],
  };
}

function thread(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: THREAD,
    type: CHANNEL_TYPES.publicThread,
    parent_id: SUPPORT,
    name: 'release checklist',
    ...overrides,
  };
}

describe('the threads GUILD_CREATE carries alongside its channels', () => {
  test('are stored, so a message posted in a thread resolves to a known channel', () => {
    const state = buildGuildState(guildCreate({ threads: [thread()] }), BOT);

    expect(state?.channels.has(THREAD)).toBe(true);
  });

  test('keep the parent id, which is the only place a thread’s permissions can be granted', () => {
    const state = buildGuildState(guildCreate({ threads: [thread()] }), BOT);

    expect(state?.channels.get(THREAD)?.parentId).toBe(SUPPORT);
  });

  test('are marked as threads, so a send into one can be made to require the thread bit', () => {
    const state = buildGuildState(guildCreate({ threads: [thread()] }), BOT);

    expect(isThreadChannel(state?.channels.get(THREAD))).toBe(true);
  });

  test.each([
    ['a public thread', CHANNEL_TYPES.publicThread],
    ['a private thread', CHANNEL_TYPES.privateThread],
    ['an announcement thread', CHANNEL_TYPES.announcementThread],
  ])('recognise %s as a thread', (_label, type) => {
    const state = buildGuildState(guildCreate({ threads: [thread({ type })] }), BOT);

    expect(isThreadChannel(state?.channels.get(THREAD))).toBe(true);
  });

  test('do not displace the ordinary channels in the same payload', () => {
    const state = buildGuildState(guildCreate({ threads: [thread()] }), BOT);

    expect(state?.channels.has(SUPPORT)).toBe(true);
    expect(state?.channels.size).toBe(2);
  });

  test('are absent without complaint from a payload that carries no threads key', () => {
    const state = buildGuildState(guildCreate(), BOT);

    expect(state).not.toBeNull();
    expect(state?.channels.size).toBe(1);
  });

  test('carry no overwrites of their own, which is what makes the parent lookup necessary', () => {
    const state = buildGuildState(guildCreate({ threads: [thread()] }), BOT);

    expect(state?.channels.get(THREAD)?.overwrites).toEqual([]);
  });
});

describe('ordinary channels', () => {
  test('keep their own type, so a forum is never mistaken for the threads inside it', () => {
    const state = buildGuildState(
      guildCreate({
        channels: [
          { id: SUPPORT, type: CHANNEL_TYPES.guildForum, parent_id: null },
          { id: ARCHIVE_CATEGORY, type: CHANNEL_TYPES.guildCategory, parent_id: null },
        ],
      }),
      BOT,
    );

    expect(isThreadChannel(state?.channels.get(SUPPORT))).toBe(false);
    expect(isThreadChannel(state?.channels.get(ARCHIVE_CATEGORY))).toBe(false);
  });

  test('a channel whose payload omits the type is left untyped rather than called text', () => {
    const parsed = parseChannel({ id: GENERAL, parent_id: null, permission_overwrites: [] });

    expect(parsed?.type).toBeUndefined();
    expect(isThreadChannel(parsed)).toBe(false);
  });
});

describe('the deletion this whole fix was measured against', () => {
  const overwriteOnSupport = [
    {
      id: BOT_ROLE,
      type: 0,
      allow: String(Permissions.ManageMessages),
      deny: '0',
    },
  ];

  function permissionsIn(channelId: string): bigint {
    const state = buildGuildState(
      guildCreate({
        channels: [
          {
            id: SUPPORT,
            type: CHANNEL_TYPES.guildText,
            parent_id: null,
            permission_overwrites: overwriteOnSupport,
          },
        ],
        threads: [thread()],
      }),
      BOT,
    );
    if (!state) throw new Error('expected buildGuildState to yield state');

    const channel = state.channels.get(channelId);

    return computeChannelPermissions(
      {
        guildOwnerId: state.ownerId,
        everyoneRoleId: state.everyoneRoleId,
        memberId: BOT,
        memberRoleIds: state.botRoleIds,
        roles: state.roles,
      },
      channel?.overwrites ?? [],
      state.channels.get(channel?.parentId ?? '')?.overwrites ?? [],
    );
  }

  test('ManageMessages granted by an overwrite on #support is held in #support', () => {
    expect(permissionsIn(SUPPORT) & Permissions.ManageMessages).toBe(Permissions.ManageMessages);
  });

  test('and is held inside a thread under #support, which used to compute with no overwrites', () => {
    expect(permissionsIn(THREAD) & Permissions.ManageMessages).toBe(Permissions.ManageMessages);
  });
});
