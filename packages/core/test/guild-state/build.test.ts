import { describe, expect, test } from 'bun:test';
import { buildGuildState, parseChannel, parseGuildProfile } from '../../src/guild-state/build.ts';
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

const ICON = 'a_0123456789abcdef0123456789abcdef';
const BANNER = '0123456789abcdef0123456789abcdef';
const PROFILE_KEYS = ['iconHash', 'bannerHash', 'description', 'boostCount', 'boostTier'];

describe('the server profile GUILD_CREATE carries', () => {
  test('is kept, so server placeholders can show the icon, banner, description and boosts', () => {
    const state = buildGuildState(
      {
        ...guildCreate(),
        icon: ICON,
        banner: BANNER,
        description: 'A place for testing',
        premium_subscription_count: 14,
        premium_tier: 2,
      },
      BOT,
    );

    expect(state).toMatchObject({
      iconHash: ICON,
      bannerHash: BANNER,
      description: 'A place for testing',
      boostCount: 14,
      boostTier: 2,
    });
  });

  test('is stamped with the time it was read, which an older GUILD_UPDATE is measured against', () => {
    expect(buildGuildState(guildCreate(), BOT, 1_800_000_000_000)?.profileAt).toBe(
      1_800_000_000_000,
    );
  });

  test('keeps Discord’s null as null, so "none set" stays distinct from "never seen"', () => {
    const state = buildGuildState(
      { ...guildCreate(), icon: null, banner: null, description: null },
      BOT,
    );

    expect(state?.iconHash).toBeNull();
    expect(state?.bannerHash).toBeNull();
    expect(state?.description).toBeNull();
  });

  test('leaves out what the payload did not carry, rather than inventing an empty value', () => {
    const state = buildGuildState(guildCreate(), BOT);
    if (!state) throw new Error('expected buildGuildState to yield state');

    for (const key of PROFILE_KEYS) expect(key in state).toBe(false);
  });

  test('still reads the name and member count exactly as before', () => {
    const state = buildGuildState(guildCreate(), BOT);

    expect(state?.name).toBe('Proton Test Guild');
    expect(state?.memberCount).toBe(3);
    expect(buildGuildState({ ...guildCreate(), name: '' }, BOT)?.name).toBeUndefined();
  });
});

describe('parseGuildProfile, which reads GUILD_UPDATE', () => {
  test('reads every profile field a guild object carries', () => {
    expect(
      parseGuildProfile({
        id: GUILD,
        name: 'Renamed',
        icon: ICON,
        banner: null,
        description: 'Now with a description',
        premium_subscription_count: 15,
        premium_tier: 3,
      }),
    ).toEqual({
      name: 'Renamed',
      iconHash: ICON,
      bannerHash: null,
      description: 'Now with a description',
      boostCount: 15,
      boostTier: 3,
    });
  });

  test('returns only what it read, so an absent field cannot clear a stored one', () => {
    const profile = parseGuildProfile({ id: GUILD, premium_tier: 0 });

    expect(Object.keys(profile)).toEqual(['boostTier']);
  });

  test('an empty name is left out rather than blanking the stored one', () => {
    expect(Object.keys(parseGuildProfile({ name: '' }))).toEqual([]);
  });

  test('a boost count and tier of zero are kept, since zero is a real reading', () => {
    expect(parseGuildProfile({ premium_subscription_count: 0, premium_tier: 0 })).toEqual({
      boostCount: 0,
      boostTier: 0,
    });
  });

  test('a null boost count is kept as none, not dropped as unread', () => {
    expect(parseGuildProfile({ premium_subscription_count: null })).toEqual({ boostCount: null });
  });

  test.each([
    ['a path', '../../avatars/1/abc'],
    ['a query string', 'abc?size=4096'],
    ['a whole URL', 'https://example.com/x.png'],
    ['spaced', 'abc def'],
    ['empty', ''],
    ['longer than any hash', 'a'.repeat(65)],
    ['a number', 42],
  ])('an image hash that is %s is ignored, so it can never steer a CDN link', (_label, hash) => {
    expect(Object.keys(parseGuildProfile({ icon: hash, banner: hash }))).toEqual([]);
  });

  test.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['beyond the safe integers', 2 ** 53],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['text', '14'],
  ])('a boost count or tier that is %s is ignored', (_label, value) => {
    expect(
      Object.keys(parseGuildProfile({ premium_subscription_count: value, premium_tier: value })),
    ).toEqual([]);
  });

  test('a description that is not text is ignored', () => {
    expect(Object.keys(parseGuildProfile({ description: { text: 'hi' } }))).toEqual([]);
  });

  test('a description is stored as written; escaping mentions and markdown is the renderer’s job', () => {
    const description = '@everyone <@&410000000000000005> **{server.name}**';

    expect(parseGuildProfile({ description }).description).toBe(description);
  });

  test('reads only the payload’s own keys, so a polluted prototype cannot supply a profile', () => {
    const inherited = Object.create({
      name: 'Injected',
      icon: ICON,
      premium_tier: 3,
    }) as Record<string, unknown>;

    expect(Object.keys(parseGuildProfile(inherited))).toEqual([]);
  });

  test('a __proto__ key in the JSON neither pollutes objects nor enters the profile', () => {
    const payload = JSON.parse(
      '{"__proto__":{"polluted":true,"name":"Injected"},"constructor":{"prototype":{"polluted":true}},"premium_tier":1}',
    ) as Record<string, unknown>;

    const profile = parseGuildProfile(payload);

    expect(Object.keys(profile)).toEqual(['boostTier']);
    expect(profile.name).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
