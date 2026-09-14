import { describe, expect, test } from 'bun:test';
import type { ChannelState, GuildState } from '../../src/guild-state/types.ts';
import { snowflakeCreatedAt } from '../../src/ids.ts';
import {
  botDefinitions,
  buildBotValues,
  buildChannelValues,
  buildEventValues,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  CHANNEL_NAMESPACES,
  channelDefinitions,
  countableChannels,
  createPlaceholderRegistry,
  eventDefinitions,
  lookupFrom,
  type MemberFacts,
  type PlaceholderDefinitionInput,
  PROTON_SUPPORT_URL,
  type ResolvedValue,
  renderTemplate,
  resolvedValueSchema,
  SAMPLE_BOT,
  SAMPLE_NOW,
  SHARED_PINGS,
  serverDefinitions,
  serverFactsFrom,
  type TemplateField,
  timeDefinitions,
  typeOf,
  USER_NAMESPACES,
  type UserFacts,
  userDefinitions,
  placeholderValue as v,
  withAliases,
  withAvailability,
} from '../../src/placeholders/index.ts';
import { codes } from './harness.ts';

const MEMBER_ID = '100000000000000010';
const GUILD_ID = '100000000000000001';
const OWNER_ID = '100000000000000002';
const CHANNEL_ID = '100000000000000040';
const CATEGORY_ID = '100000000000000041';
const ROLES = ['100000000000000020', '100000000000000021'];
const CREATED = snowflakeCreatedAt(MEMBER_ID) ?? 0;
const DEFAULT_AVATAR = `https://cdn.discordapp.com/embed/avatars/${(BigInt(MEMBER_ID) >> 22n) % 6n}.png`;

const USER: UserFacts = {
  id: MEMBER_ID,
  username: 'fraimer',
  globalName: 'Fraimer',
  avatarHash: null,
};

const MEMBERSHIP: MemberFacts = {
  nick: 'Fraim',
  joinedAt: '2026-09-01T00:00:00.000Z',
  premiumSince: '2026-09-10T00:00:00.000Z',
  roleIds: ROLES,
};

const registry = createPlaceholderRegistry([
  ...USER_NAMESPACES.flatMap((namespace) => userDefinitions(namespace, { member: true })),
  ...serverDefinitions(),
  ...CHANNEL_NAMESPACES.flatMap((namespace) => channelDefinitions(namespace)),
  ...botDefinitions(),
  ...eventDefinitions(),
  ...timeDefinitions(),
]);

function render(
  template: string,
  values: Record<string, ResolvedValue>,
  field: TemplateField = 'discord_text',
) {
  return renderTemplate(template, lookupFrom(values), { registry, field, now: SAMPLE_NOW });
}

function user(
  overrides: Partial<UserFacts> = {},
  member: MemberFacts | null | 'unavailable' = MEMBERSHIP,
): Record<string, ResolvedValue> {
  return buildUserValues('user', { ...USER, ...overrides }, member, SAMPLE_NOW);
}

function stateOf(value: ResolvedValue | undefined): string | undefined {
  return value?.type === 'absent' ? value.state : value?.type;
}

describe('the shared namespaces', () => {
  test('register together with no key claimed twice, and carry no aliases of their own', () => {
    expect(registry.definitions).toHaveLength(4 * 15 + 12 + 2 * 5 + 6 + 2 + 3);
    expect(registry.definitions.filter(({ aliases }) => aliases.length > 0)).toEqual([]);
  });

  test('every value a builder writes is a valid value of its own definition, and every definition gets one', () => {
    const built: Record<string, ResolvedValue> = {
      ...buildUserValues('user', USER, MEMBERSHIP, SAMPLE_NOW),
      ...buildUserValues('actor', USER, null, SAMPLE_NOW),
      ...buildUserValues('moderator', null, 'unavailable', SAMPLE_NOW),
      ...buildUserValues(
        'target',
        { ...USER, avatarHash: 'a_abc' },
        { nick: undefined },
        SAMPLE_NOW,
      ),
      ...buildServerValues({
        id: GUILD_ID,
        name: 'Proton HQ',
        memberCount: 3,
        ownerId: OWNER_ID,
        roleCount: 2,
        channelCount: 5,
        iconHash: 'a_abc',
        bannerHash: 'def',
        description: 'Hi',
        boostCount: 1,
        boostTier: 1,
      }),
      ...buildChannelValues(
        'channel',
        { id: CHANNEL_ID, name: 'general', parentId: CATEGORY_ID },
        GUILD_ID,
      ),
      ...buildChannelValues('destination_channel', null, GUILD_ID),
      ...buildBotValues(SAMPLE_BOT),
      ...buildEventValues({ id: 'event-1', occurredAt: SAMPLE_NOW }),
      ...buildTimeValues(SAMPLE_NOW),
    };

    for (const [key, value] of Object.entries(built)) {
      const resolution = registry.resolve(key);
      expect(resolution?.canonical).toBe(key);
      expect(resolvedValueSchema.safeParse(value).success).toBe(true);
      if (resolution !== undefined && value.type !== 'absent') {
        expect(typeOf(value)).toBe(resolution.definition.type);
      }
    }

    expect(
      registry.definitions.map(({ key }) => key).filter((key) => !Object.hasOwn(built, key)),
    ).toEqual([]);
  });
});

describe('user.*', () => {
  test('reads a member with a nickname, a display name and roles', () => {
    expect(user()).toEqual({
      'user.id': v.text(MEMBER_ID),
      'user.mention': v.user(MEMBER_ID, 'Fraim'),
      'user.username': v.text('fraimer'),
      'user.global_name': v.text('Fraimer'),
      'user.display_name': v.text('Fraim'),
      'user.avatar_url': v.imageUrl(DEFAULT_AVATAR),
      'user.is_bot': v.boolean(false),
      'user.created_at': v.datetime(CREATED),
      'user.account_age': v.duration(SAMPLE_NOW - CREATED),
      'user.nickname': v.text('Fraim'),
      'user.joined_at': v.datetime(Date.parse('2026-09-01T00:00:00.000Z')),
      'user.is_boosting': v.boolean(true),
      'user.boosting_since': v.datetime(Date.parse('2026-09-10T00:00:00.000Z')),
      'user.role_mentions': v.list(
        'mention',
        ROLES.map((id) => v.role(id)),
      ),
      'user.role_count': v.integer(2),
    });
  });

  test('an empty nickname counts as none, as the boost greeting always read it', () => {
    const values = user({}, { ...MEMBERSHIP, nick: '' });

    expect(values['user.display_name']).toEqual(v.text('Fraimer'));
    expect(values['user.mention']).toEqual(v.user(MEMBER_ID, 'Fraimer'));
    expect(values['user.nickname']).toEqual(v.notSet());
  });

  test('a nickname nobody read is unavailable, and no nickname at all is not set', () => {
    expect(stateOf(user({}, { nick: undefined })['user.nickname'])).toBe('unavailable');
    expect(stateOf(user({}, { nick: null })['user.nickname'])).toBe('not_set');
    expect(user({}, { nick: undefined })['user.display_name']).toEqual(v.text('Fraimer'));
  });

  test('the display name falls back to the username, and an empty one renders empty as greetings did', () => {
    expect(user({ globalName: null })['user.global_name']).toEqual(v.text('fraimer'));
    expect(user({ globalName: '' }, { nick: null })['user.global_name']).toEqual(v.text(''));
    expect(user({ globalName: '' }, { nick: null })['user.display_name']).toEqual(v.text(''));

    const unread = user({ globalName: null, username: null }, { nick: null });
    expect(stateOf(unread['user.global_name'])).toBe('unavailable');
    expect(stateOf(unread['user.display_name'])).toBe('unavailable');
    expect(stateOf(unread['user.avatar_url'])).toBe('unavailable');
    expect(unread['user.mention']).toEqual(v.user(MEMBER_ID));
  });

  test('an avatar hash becomes a CDN link, and an animated one a gif', () => {
    expect(user({ avatarHash: 'abc' })['user.avatar_url']).toEqual(
      v.imageUrl(`https://cdn.discordapp.com/avatars/${MEMBER_ID}/abc.png?size=256`),
    );
    expect(user({ avatarHash: 'a_abc' })['user.avatar_url']).toEqual(
      v.imageUrl(`https://cdn.discordapp.com/avatars/${MEMBER_ID}/a_abc.gif?size=256`),
    );
  });

  test('membership the event does not carry is unavailable, and the account still resolves', () => {
    const values = user({}, 'unavailable');
    const reason = v.unavailable('this event does not say what they have in this server');

    for (const key of [
      'user.nickname',
      'user.joined_at',
      'user.is_boosting',
      'user.boosting_since',
      'user.role_mentions',
      'user.role_count',
    ]) {
      expect(values[key]).toEqual(reason);
    }
    expect(values['user.display_name']).toEqual(v.text('Fraimer'));
    expect(stateOf(user({}, null)['user.nickname'])).toBe('unavailable');
  });

  test('a profile that could not be read fails, and membership still reads', () => {
    const values = buildUserValues('user', null, MEMBERSHIP, SAMPLE_NOW);

    expect(stateOf(values['user.id'])).toBe('failed');
    expect(stateOf(values['user.mention'])).toBe('failed');
    expect(values['user.role_count']).toEqual(v.integer(2));
  });

  test('an id that is not a Discord id fails everything derived from it', () => {
    const values = user({ id: 'abc' });

    expect(values['user.id']).toEqual(v.text('abc'));
    for (const key of ['user.mention', 'user.created_at', 'user.account_age', 'user.avatar_url']) {
      expect(stateOf(values[key])).toBe('failed');
    }
  });

  test('roles and dates read what they can', () => {
    expect(user({}, { nick: null, roleIds: [ROLES[0] ?? '', 'nope'] })['user.role_count']).toEqual(
      v.integer(1),
    );
    expect(stateOf(user({}, { nick: null })['user.role_mentions'])).toBe('unavailable');
    expect(stateOf(user({}, { nick: null, roleIds: null })['user.role_count'])).toBe('unavailable');
    expect(stateOf(user({}, { nick: null, joinedAt: 'garbage' })['user.joined_at'])).toBe('failed');
    expect(stateOf(user({}, { nick: null, joinedAt: null })['user.joined_at'])).toBe('not_set');

    const notBoosting = user({}, { nick: null, premiumSince: null });
    expect(notBoosting['user.is_boosting']).toEqual(v.boolean(false));
    expect(stateOf(notBoosting['user.boosting_since'])).toBe('not_set');

    const unread = user({}, { nick: null });
    expect(stateOf(unread['user.is_boosting'])).toBe('unavailable');
    expect(stateOf(unread['user.boosting_since'])).toBe('unavailable');
  });

  test('a name the member controls is escaped in message text and never expanded', () => {
    const values = user({ globalName: `{server.name} <@&${ROLES[0]}> **x** @everyone` });

    expect(render('{user.global_name}', values).output).toBe(
      `{server.name} \\<@&${ROLES[0]}\\> \\*\\*x\\*\\* @​everyone`,
    );
  });

  test('zero and false are values', () => {
    expect(
      render('{user.is_bot} {user.role_count}', user({}, { nick: null, roleIds: [] })).output,
    ).toBe('No 0');
  });
});

describe('server.*', () => {
  const FULL = {
    id: GUILD_ID,
    name: 'Proton HQ',
    memberCount: 1204,
    ownerId: OWNER_ID,
    roleCount: 24,
    channelCount: 40,
    iconHash: 'a_abc',
    bannerHash: 'def',
    description: 'A place for Proton',
    boostCount: 14,
    boostTier: 2,
  };

  test('a server Proton has not seen is unavailable everywhere, and says why', () => {
    const values = Object.values(buildServerValues(null));

    expect(values).toHaveLength(12);
    for (const value of values) {
      expect(value).toEqual(
        v.unavailable("Proton has not seen this server's details since it last connected"),
      );
    }
  });

  test('reads every fact it holds', () => {
    expect(buildServerValues(FULL)).toEqual({
      'server.id': v.text(GUILD_ID),
      'server.name': v.text('Proton HQ'),
      'server.member_count': v.integer(1204),
      'server.owner_mention': v.user(OWNER_ID),
      'server.role_count': v.integer(24),
      'server.channel_count': v.integer(40),
      'server.created_at': v.datetime(snowflakeCreatedAt(GUILD_ID) ?? 0),
      'server.icon_url': v.imageUrl(
        `https://cdn.discordapp.com/icons/${GUILD_ID}/a_abc.gif?size=256`,
      ),
      'server.banner_url': v.imageUrl(
        `https://cdn.discordapp.com/banners/${GUILD_ID}/def.png?size=1024`,
      ),
      'server.description': v.text('A place for Proton'),
      'server.boost_count': v.integer(14),
      'server.boost_tier': v.integer(2),
    });
  });

  test('a fact never read is unavailable, and one Discord reports as none is not set', () => {
    const unread = buildServerValues({ id: GUILD_ID });
    for (const key of [
      'server.name',
      'server.member_count',
      'server.icon_url',
      'server.boost_tier',
    ]) {
      expect(stateOf(unread[key])).toBe('unavailable');
    }

    const none = buildServerValues({
      id: GUILD_ID,
      iconHash: null,
      bannerHash: null,
      description: null,
      boostCount: null,
    });
    for (const key of [
      'server.icon_url',
      'server.banner_url',
      'server.description',
      'server.boost_count',
    ]) {
      expect(stateOf(none[key])).toBe('not_set');
    }
  });

  test('zero renders, and a count that is not whole fails', () => {
    expect(
      render('{server.member_count}', buildServerValues({ id: GUILD_ID, memberCount: 0 })).output,
    ).toBe('0');
    expect(
      stateOf(buildServerValues({ id: GUILD_ID, memberCount: 1.5 })['server.member_count']),
    ).toBe('failed');
  });

  test('a bad id or hash can never produce a broken or redirected link', () => {
    const badId = buildServerValues({ id: 'x', iconHash: 'abc' });
    expect(stateOf(badId['server.icon_url'])).toBe('failed');
    expect(stateOf(badId['server.created_at'])).toBe('failed');

    const hostile = buildServerValues({ id: GUILD_ID, iconHash: 'a/../b?x' })['server.icon_url'];
    expect(hostile).toEqual(
      v.imageUrl(`https://cdn.discordapp.com/icons/${GUILD_ID}/a%2F..%2Fb%3Fx.png?size=256`),
    );
    expect(resolvedValueSchema.safeParse(hostile).success).toBe(true);
  });

  test('serverFactsFrom reads a GuildState snapshot, and a missing one leaves only the id', () => {
    const channel = (id: string, type?: number): ChannelState => ({
      id,
      parentId: null,
      overwrites: [],
      ...(type === undefined ? {} : { type }),
    });
    const channels = [
      channel(CHANNEL_ID, 0),
      channel(CATEGORY_ID, 4),
      channel('100000000000000042', 2),
      channel('100000000000000043', 11),
      channel('100000000000000044'),
    ];
    const state: GuildState = {
      guildId: GUILD_ID,
      ownerId: OWNER_ID,
      everyoneRoleId: GUILD_ID,
      roles: new Map(
        [GUILD_ID, ...ROLES].map((id) => [id, { id, permissions: 0n, position: 0 }] as const),
      ),
      botRoleIds: [],
      channels: new Map(channels.map((each) => [each.id, each] as const)),
      name: 'Proton HQ',
      memberCount: 1204,
      updatedAt: 0,
    };

    expect(serverFactsFrom(null, GUILD_ID)).toEqual({ id: GUILD_ID });
    expect(serverFactsFrom(state, GUILD_ID)).toEqual({
      id: GUILD_ID,
      name: 'Proton HQ',
      memberCount: 1204,
      ownerId: OWNER_ID,
      roleCount: 2,
      channelCount: 3,
    });
  });

  test('serverFactsFrom carries the GuildState profile, keeping none apart from unread', () => {
    const base: GuildState = {
      guildId: GUILD_ID,
      ownerId: OWNER_ID,
      everyoneRoleId: GUILD_ID,
      roles: new Map(),
      botRoleIds: [],
      channels: new Map(),
      updatedAt: 0,
    };
    const profiled: GuildState = {
      ...base,
      iconHash: 'a_abc',
      bannerHash: null,
      description: null,
      boostCount: 0,
      boostTier: 0,
      profileAt: 1,
    };
    const facts = serverFactsFrom(profiled, GUILD_ID);

    expect(facts).toMatchObject({
      iconHash: 'a_abc',
      bannerHash: null,
      description: null,
      boostCount: 0,
      boostTier: 0,
    });
    const values = buildServerValues(facts);
    expect(values['server.icon_url']).toEqual(
      v.imageUrl(`https://cdn.discordapp.com/icons/${GUILD_ID}/a_abc.gif?size=256`),
    );
    expect(stateOf(values['server.banner_url'])).toBe('not_set');
    expect(stateOf(values['server.description'])).toBe('not_set');
    expect(values['server.boost_count']).toEqual(v.integer(0));
    expect(values['server.boost_tier']).toEqual(v.integer(0));

    const legacy = buildServerValues(serverFactsFrom(base, GUILD_ID));
    for (const key of [
      'server.icon_url',
      'server.banner_url',
      'server.description',
      'server.boost_count',
      'server.boost_tier',
    ]) {
      expect(stateOf(legacy[key])).toBe('unavailable');
    }
  });

  test('countableChannels skips categories and threads, and counts a channel of unknown type', () => {
    const types = [0, 2, 4, 5, 10, 11, 12, 13, 15, undefined];

    expect(countableChannels(types.map((type) => ({ type }))).map(({ type }) => type)).toEqual([
      0,
      2,
      5,
      13,
      15,
      undefined,
    ]);
  });
});

describe('channel.* and destination_channel.*', () => {
  test('reads a channel Proton has seen', () => {
    expect(
      buildChannelValues(
        'channel',
        { id: CHANNEL_ID, name: 'general', parentId: CATEGORY_ID },
        GUILD_ID,
      ),
    ).toEqual({
      'channel.id': v.text(CHANNEL_ID),
      'channel.mention': v.channel(CHANNEL_ID, 'general'),
      'channel.name': v.text('general'),
      'channel.url': v.url(`https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`),
      'channel.category_mention': v.channel(CATEGORY_ID),
    });
  });

  test('a channel created this tick still mentions, with its name unavailable', () => {
    const values = buildChannelValues('destination_channel', { id: CHANNEL_ID }, GUILD_ID);

    expect(render('{destination_channel.mention}', values).output).toBe(`<#${CHANNEL_ID}>`);
    expect(stateOf(values['destination_channel.name'])).toBe('unavailable');
    expect(stateOf(values['destination_channel.category_mention'])).toBe('unavailable');

    const plain = render('[{destination_channel.mention}]', values, 'plain_text');
    expect(plain.output).toBe('[]');
    expect(codes(plain)).toEqual(['mention_without_name']);
  });

  test('a mention shows the channel name where mentions cannot be shown', () => {
    const values = buildChannelValues(
      'destination_channel',
      { id: CHANNEL_ID, name: 'general', parentId: null },
      GUILD_ID,
    );

    expect(render('{destination_channel.mention}', values, 'plain_text').output).toBe('general');
    expect(stateOf(values['destination_channel.category_mention'])).toBe('not_set');
  });

  test('no channel at all is unavailable, and a bad id fails', () => {
    for (const value of Object.values(buildChannelValues('channel', null, GUILD_ID))) {
      expect(stateOf(value)).toBe('unavailable');
    }

    const bad = buildChannelValues('channel', { id: 'x', name: 'general' }, GUILD_ID);
    expect(stateOf(bad['channel.mention'])).toBe('failed');
    expect(stateOf(bad['channel.url'])).toBe('failed');
  });
});

describe('bot.*', () => {
  test('without the environment every key is unavailable, apart from the support link', () => {
    expect(buildBotValues(null)).toEqual({
      'bot.id': v.unavailable('the process running modules did not provide placeholders'),
      'bot.mention': v.unavailable('the process running modules did not provide placeholders'),
      'bot.name': v.unavailable('the process running modules did not provide placeholders'),
      'bot.avatar_url': v.unavailable('the process running modules did not provide placeholders'),
      'bot.website_url': v.unavailable('the process running modules did not provide placeholders'),
      'bot.support_url': v.url(PROTON_SUPPORT_URL),
    });
  });

  test('reads Proton’s own profile', () => {
    const id = SAMPLE_BOT.id;

    expect(buildBotValues(SAMPLE_BOT)).toEqual({
      'bot.id': v.text(id),
      'bot.mention': v.user(id, 'Proton'),
      'bot.name': v.text('Proton'),
      'bot.avatar_url': v.imageUrl(
        `https://cdn.discordapp.com/embed/avatars/${(BigInt(id) >> 22n) % 6n}.png`,
      ),
      'bot.website_url': v.url('https://prtn.xyz'),
      'bot.support_url': v.url(PROTON_SUPPORT_URL),
    });
  });

  test('a profile that could not be read fails, one not read yet is unavailable', () => {
    const failed = buildBotValues({ ...SAMPLE_BOT, name: null });
    expect(stateOf(failed['bot.name'])).toBe('failed');
    expect(stateOf(failed['bot.avatar_url'])).toBe('failed');
    expect(failed['bot.mention']).toEqual(v.user(SAMPLE_BOT.id));

    const unread = buildBotValues({ id: SAMPLE_BOT.id, supportUrl: PROTON_SUPPORT_URL });
    for (const key of ['bot.name', 'bot.avatar_url', 'bot.website_url']) {
      expect(stateOf(unread[key])).toBe('unavailable');
    }

    const hostile = buildBotValues({ ...SAMPLE_BOT, websiteUrl: 'javascript:alert(1)' });
    expect(stateOf(hostile['bot.website_url'])).toBe('failed');
  });
});

describe('event.* and time', () => {
  test('time values come from the render clock, in UTC', () => {
    expect(buildTimeValues(SAMPLE_NOW)).toEqual({
      now: v.datetime(SAMPLE_NOW),
      today: v.datetime(Date.UTC(2026, 8, 14)),
      year: v.integer(2026),
    });
    expect(buildTimeValues(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toMatchObject({
      today: v.datetime(Date.UTC(2026, 11, 31)),
      year: v.integer(2026),
    });

    for (const value of Object.values(buildTimeValues(Number.NaN))) {
      expect(stateOf(value)).toBe('failed');
    }

    const values = buildTimeValues(SAMPLE_NOW);
    expect(render('{today:date} {year}', values, 'plain_text').output).toBe('Sep 14, 2026 2026');
  });

  test('event values come from the event, and a message with no event has none', () => {
    expect(buildEventValues({ id: 'event-1', occurredAt: SAMPLE_NOW })).toEqual({
      'event.id': v.text('event-1'),
      'event.created_at': v.datetime(SAMPLE_NOW),
    });
    expect(stateOf(buildEventValues(null)['event.id'])).toBe('unavailable');
    expect(stateOf(buildEventValues({ id: 'e', occurredAt: 1.5 })['event.created_at'])).toBe(
      'failed',
    );
  });
});

describe('shared helpers', () => {
  test('SHARED_PINGS names every role list and the owner mention, and cannot be changed', () => {
    expect(SHARED_PINGS).toEqual({
      'user.role_mentions': 'roles',
      'server.owner_mention': 'users',
      'actor.role_mentions': 'roles',
      'moderator.role_mentions': 'roles',
      'target.role_mentions': 'roles',
    });
    expect(Object.isFrozen(SHARED_PINGS)).toBe(true);
  });

  test('withAliases and withAvailability return new definitions and keep the rest', () => {
    const [id] = serverDefinitions();
    const base: PlaceholderDefinitionInput = {
      ...(id ?? {
        key: 'server.id',
        label: 'ID',
        group: 'Server',
        type: 'text',
        example: v.text('1'),
      }),
      availability: { fields: ['plain_text'] },
    };

    expect(withAliases(base, ['guildId']).aliases).toEqual(['guildId']);
    expect(withAvailability(base, ['welcome.join']).availability).toEqual({
      fields: ['plain_text'],
      events: ['welcome.join'],
    });
    expect(base.aliases).toBeUndefined();
    expect(base.availability).toEqual({ fields: ['plain_text'] });
  });
});
