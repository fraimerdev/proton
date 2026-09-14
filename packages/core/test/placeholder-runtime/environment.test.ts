import { describe, expect, test } from 'bun:test';
import type { ChannelState, GuildState } from '../../src/guild-state/types.ts';
import type { GuildRole } from '../../src/permissions/compute.ts';
import {
  createPlaceholderEnvironment,
  type PlaceholderEnvironment,
  type PlaceholderEnvironmentDeps,
} from '../../src/placeholder-runtime/index.ts';
import {
  botDefinitions,
  buildBotValues,
  buildServerValues,
  buildUserValues,
  createPlaceholderRegistry,
  lookupFrom,
  PROTON_SUPPORT_URL,
  renderTemplate,
  serverDefinitions,
  userDefinitions,
  placeholderValue as v,
} from '../../src/placeholders/index.ts';
import type { UserProfile } from '../../src/users/profile-cache.ts';
import type { UserResolver } from '../../src/users/resolver.ts';

const APP = '100000000000000099';
const GUILD = '100000000000000001';
const OWNER = '100000000000000002';
const MEMBER = '100000000000000010';
const HOUR = 3_600_000;
const DASHBOARD = 'https://prtn.xyz';

type Answer = (userId: string) => Promise<UserProfile | null>;

function profile(id: string, extra: Partial<UserProfile> = {}): UserProfile {
  return {
    id,
    username: 'proton',
    globalName: 'Proton',
    avatarUrl: null,
    avatarHash: 'a_1f2e',
    ...extra,
  };
}

interface HarnessOptions {
  answer?: Answer;
  state?: () => Promise<GuildState | null>;
  applicationId?: string;
  dashboardUrl?: string;
}

function harness(options: HarnessOptions = {}) {
  const lookups: string[] = [];
  const reads: string[] = [];
  let clock = 0;

  const answer: Answer = options.answer ?? (async (id) => profile(id));
  const state = options.state ?? (async () => null);

  const users: UserResolver = {
    resolve: (userId) => {
      lookups.push(userId);
      return answer(userId);
    },
  };

  const deps: PlaceholderEnvironmentDeps = {
    applicationId: options.applicationId ?? APP,
    dashboardUrl: options.dashboardUrl ?? DASHBOARD,
    users,
    guildState: {
      get: (guildId) => {
        reads.push(guildId);
        return state();
      },
    },
    now: () => clock,
  };

  const env: PlaceholderEnvironment = createPlaceholderEnvironment(deps);

  return {
    env,
    lookups,
    reads,
    at: (ms: number) => {
      clock = ms;
    },
  };
}

const role = (id: string, position: number): [string, GuildRole] => [
  id,
  { id, permissions: 0n, position },
];

const channel = (id: string, type?: number): [string, ChannelState] => [
  id,
  type === undefined
    ? { id, parentId: null, overwrites: [] }
    : { id, parentId: null, type, overwrites: [] },
];

function snapshot(): GuildState {
  return {
    guildId: GUILD,
    ownerId: OWNER,
    everyoneRoleId: GUILD,
    roles: new Map([role(GUILD, 0), role('100000000000000020', 1), role('100000000000000021', 2)]),
    botRoleIds: [],
    channels: new Map([
      channel('100000000000000030', 0),
      channel('100000000000000031', 2),
      channel('100000000000000032', 4),
      channel('100000000000000033', 11),
      channel('100000000000000034'),
    ]),
    name: 'Proton HQ',
    memberCount: 1204,
    updatedAt: 1,
  };
}

const PROFILE: Pick<
  GuildState,
  'iconHash' | 'bannerHash' | 'description' | 'boostCount' | 'boostTier' | 'profileAt'
> = {
  iconHash: 'a_icon',
  bannerHash: null,
  description: 'A place for Proton',
  boostCount: 0,
  boostTier: 1,
  profileAt: 1,
};

const failed = { type: 'absent', state: 'failed' };

describe('bot()', () => {
  test("reads Proton's own profile and fills every bot fact", async () => {
    const { env, lookups } = harness();
    const facts = await env.bot();

    expect(facts).toEqual({
      id: APP,
      name: 'Proton',
      avatarHash: 'a_1f2e',
      websiteUrl: DASHBOARD,
      supportUrl: PROTON_SUPPORT_URL,
    });
    expect(lookups).toEqual([APP]);

    const values = buildBotValues(facts);
    expect(values['bot.name']).toEqual(v.text('Proton'));
    expect(values['bot.mention']).toEqual(v.user(APP, 'Proton'));
    expect(values['bot.avatar_url']).toEqual(
      v.imageUrl(`https://cdn.discordapp.com/avatars/${APP}/a_1f2e.gif?size=256`),
    );
    expect(values['bot.website_url']).toEqual(v.url(DASHBOARD));
    expect(values['bot.support_url']).toEqual(v.url(PROTON_SUPPORT_URL));
  });

  test('falls back to the username when Proton has no display name', async () => {
    const { env } = harness({ answer: async (id) => profile(id, { globalName: null }) });

    expect((await env.bot()).name).toBe('proton');
  });

  test('keeps the profile for six hours, then reads it again', async () => {
    const { env, lookups, at } = harness();

    await env.bot();
    at(6 * HOUR - 1);
    await env.bot();
    expect(lookups).toHaveLength(1);

    at(6 * HOUR);
    await env.bot();
    expect(lookups).toHaveLength(2);
  });

  test('callers asking at once share one read', async () => {
    let release: (value: UserProfile) => void = () => {};
    const { env, lookups } = harness({
      answer: () =>
        new Promise<UserProfile>((resolve) => {
          release = resolve;
        }),
    });

    const first = env.bot();
    const second = env.bot();
    release(profile(APP));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(lookups).toEqual([APP]);
  });

  test('a profile Proton cannot read renders failed, and is read again after a minute but not before', async () => {
    let answer: UserProfile | null = null;
    const { env, lookups, at } = harness({ answer: async () => answer });

    const unread = await env.bot();
    expect(unread).toEqual({
      id: APP,
      name: null,
      avatarHash: null,
      websiteUrl: DASHBOARD,
      supportUrl: PROTON_SUPPORT_URL,
    });

    const values = buildBotValues(unread);
    expect(values['bot.name']).toMatchObject(failed);
    expect(values['bot.avatar_url']).toMatchObject(failed);
    expect(values['bot.id']).toEqual(v.text(APP));
    expect(values['bot.support_url']).toEqual(v.url(PROTON_SUPPORT_URL));

    answer = profile(APP);
    at(59_999);
    expect((await env.bot()).name).toBeNull();
    expect(lookups).toHaveLength(1);

    at(60_000);
    expect((await env.bot()).name).toBe('Proton');

    at(60_000 + 6 * HOUR - 1);
    await env.bot();
    expect(lookups).toHaveLength(2);
  });

  test('a resolver that throws is a failed read, never a rejected bot()', async () => {
    const answers: Answer[] = [
      async () => {
        throw new Error('rest proxy down');
      },
      () => {
        throw new Error('profile cache down');
      },
    ];

    for (const answer of answers) {
      const { env, lookups, at } = harness({ answer });

      expect((await env.bot()).name).toBeNull();
      at(60_000);
      expect((await env.bot()).name).toBeNull();
      expect(lookups).toHaveLength(2);
    }
  });

  test('an application id that is not a Discord id is never looked up', async () => {
    for (const applicationId of ['', '1234', '../users/@me', `${APP}/guilds`, '__proto__']) {
      const { env, lookups } = harness({ applicationId });

      expect((await env.bot()).name).toBeNull();
      expect(lookups).toEqual([]);
    }
  });

  test("a profile answered for some other id is not taken as Proton's", async () => {
    const { env } = harness({ answer: async () => profile(MEMBER) });

    expect((await env.bot()).name).toBeNull();
  });

  test('the kept facts are frozen, so one caller cannot change them for the next', async () => {
    const { env } = harness();
    const facts = await env.bot();

    expect(Object.isFrozen(facts)).toBe(true);
    expect(() => Object.assign(facts, { name: 'Hacked' })).toThrow(TypeError);
    expect((await env.bot()).name).toBe('Proton');
  });

  test('a dashboard address that is not a web link renders failed', async () => {
    const { env } = harness({ dashboardUrl: 'javascript:alert(1)' });

    expect(buildBotValues(await env.bot())['bot.website_url']).toMatchObject(failed);
  });
});

describe('server()', () => {
  test('one GuildState read becomes the server facts', async () => {
    const { env, reads } = harness({ state: async () => ({ ...snapshot(), ...PROFILE }) });
    const facts = await env.server(GUILD);

    expect(reads).toEqual([GUILD]);
    expect(facts).toEqual({
      id: GUILD,
      name: 'Proton HQ',
      memberCount: 1204,
      ownerId: OWNER,
      roleCount: 2,
      channelCount: 3,
      iconHash: 'a_icon',
      bannerHash: null,
      description: 'A place for Proton',
      boostCount: 0,
      boostTier: 1,
    });

    const values = buildServerValues(facts);
    expect(values['server.name']).toEqual(v.text('Proton HQ'));
    expect(values['server.boost_count']).toEqual(v.integer(0));
    expect(values['server.banner_url']).toMatchObject({ type: 'absent', state: 'not_set' });
    expect(values['server.icon_url']).toEqual(
      v.imageUrl(`https://cdn.discordapp.com/icons/${GUILD}/a_icon.gif?size=256`),
    );
  });

  test('a snapshot from before server profiles leaves those facts unread, not empty', async () => {
    const { env } = harness({ state: async () => snapshot() });
    const values = buildServerValues(await env.server(GUILD));

    expect(values['server.name']).toEqual(v.text('Proton HQ'));
    for (const key of ['icon_url', 'banner_url', 'description', 'boost_count', 'boost_tier']) {
      expect(values[`server.${key}`]).toMatchObject({ type: 'absent', state: 'unavailable' });
    }
  });

  test('no snapshot yet leaves every fact but the id unavailable', async () => {
    const { env, reads } = harness();
    const facts = await env.server(GUILD);

    expect(facts).toEqual({ id: GUILD });
    expect(reads).toEqual([GUILD]);

    const values = buildServerValues(facts);
    expect(values['server.id']).toEqual(v.text(GUILD));
    expect(values['server.name']).toMatchObject({ type: 'absent', state: 'unavailable' });
  });

  test('every call reads again, so a rename shows at once', async () => {
    let name = 'Old name';
    const { env, reads } = harness({ state: async () => ({ ...snapshot(), name }) });

    expect((await env.server(GUILD)).name).toBe('Old name');
    name = 'New name';
    expect((await env.server(GUILD)).name).toBe('New name');
    expect(reads).toEqual([GUILD, GUILD]);
  });

  test('a guild id that is not a Discord id is never read', async () => {
    for (const guildId of ['', '*', '1:2', `${GUILD}:bot`, `${GUILD}\n`, '../x', '__proto__']) {
      const { env, reads } = harness({ state: async () => snapshot() });

      expect(await env.server(guildId)).toEqual({ id: guildId });
      expect(reads).toEqual([]);
    }
  });

  test('a GuildState store that fails rejects, so the event is retried instead of posted with blanks', async () => {
    const { env } = harness({
      state: async () => {
        throw new Error('redis down');
      },
    });

    await expect(env.server(GUILD)).rejects.toThrow('redis down');
  });
});

describe('user()', () => {
  test('a resolved profile becomes user facts, carrying nothing else', async () => {
    const { env, lookups } = harness({
      answer: async (id) =>
        profile(id, {
          username: 'fraimer',
          globalName: 'Fraimer',
          avatarHash: null,
          avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png',
        }),
    });
    const facts = await env.user(MEMBER);

    expect(facts).toStrictEqual({
      id: MEMBER,
      username: 'fraimer',
      globalName: 'Fraimer',
      avatarHash: null,
    });
    expect(lookups).toEqual([MEMBER]);

    const values = buildUserValues('user', facts, 'unavailable', 0);
    expect(values['user.global_name']).toEqual(v.text('Fraimer'));
    expect(values['user.mention']).toEqual(v.user(MEMBER, 'Fraimer'));
  });

  test('a user Discord will not return, a resolver that throws, or a profile for someone else is failed', async () => {
    const answers: Answer[] = [
      async () => null,
      async () => {
        throw new Error('rest proxy down');
      },
      () => {
        throw new Error('profile cache down');
      },
      async () => profile(OWNER),
    ];

    for (const answer of answers) {
      const { env } = harness({ answer });
      const facts = await env.user(MEMBER);

      expect(facts).toBeNull();
      expect(buildUserValues('user', facts, null, 0)['user.username']).toMatchObject(failed);
    }
  });

  test('each call asks the resolver, which owns the cache and the in-flight dedupe', async () => {
    const { env, lookups } = harness();

    await env.user(MEMBER);
    await env.user(MEMBER);
    expect(lookups).toEqual([MEMBER, MEMBER]);
  });

  test('an id that is not a Discord id never reaches the resolver', async () => {
    for (const userId of [
      '',
      '12345',
      `${MEMBER}/../../guilds/${GUILD}/bans`,
      `${MEMBER}?with_counts=true`,
      ` ${MEMBER}`,
      '../@me',
      '__proto__',
      'constructor',
    ]) {
      const { env, lookups } = harness();

      expect(await env.user(userId)).toBeNull();
      expect(lookups).toEqual([]);
    }
  });

  test("Proton's pseudo actors go to the resolver, which answers them without Discord", async () => {
    const { env, lookups } = harness({
      answer: async (id) =>
        profile(id, { username: 'automod', globalName: null, avatarHash: null }),
    });

    expect(await env.user('proton:automod')).toStrictEqual({
      id: 'proton:automod',
      username: 'automod',
      globalName: null,
      avatarHash: null,
    });
    expect(lookups).toEqual(['proton:automod']);
  });

  test('a hostile profile carries only the four facts and pollutes nothing', async () => {
    const hostile: UserProfile = JSON.parse(
      `{"id":"${MEMBER}","username":"x","globalName":null,"avatarUrl":null,"avatarHash":null,"bot":true,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
    );
    const { env } = harness({ answer: async () => hostile });
    const facts = await env.user(MEMBER);

    expect(facts).toStrictEqual({ id: MEMBER, username: 'x', globalName: null, avatarHash: null });
    expect(Object.getPrototypeOf(facts)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('rendering from the environment', () => {
  test('bot, server and member facts render through the engine, escaped where members wrote them', async () => {
    const { env } = harness({
      answer: async (id) =>
        id === APP
          ? profile(APP)
          : profile(id, { username: 'fraimer', globalName: '**Fraim** <@&1>' }),
      state: async () => ({ ...snapshot(), name: 'Proton @everyone' }),
    });

    const registry = createPlaceholderRegistry([
      ...botDefinitions(),
      ...serverDefinitions(),
      ...userDefinitions('user', { member: false }),
    ]);
    const lookup = lookupFrom({
      ...buildBotValues(await env.bot()),
      ...buildServerValues(await env.server(GUILD)),
      ...buildUserValues('user', await env.user(MEMBER), 'unavailable', env.now()),
    });

    const { output, diagnostics } = renderTemplate(
      '{user.global_name} joined {server.name}, says {bot.name}',
      lookup,
      { registry, field: 'discord_text' },
    );

    expect(diagnostics).toEqual([]);
    expect(output).toEndWith(', says Proton');
    expect(output).not.toMatch(/(^|[^\\])<@&/);
    expect(output).not.toContain('**');
    expect(output).not.toContain('@everyone');
  });
});

describe('the environment itself', () => {
  test('carries the application id and reads the clock it was given', () => {
    const { env, at } = harness();

    expect(env.applicationId).toBe(APP);
    at(1_234);
    expect(env.now()).toBe(1_234);
  });

  test('reads the wall clock when none is given', () => {
    const env = createPlaceholderEnvironment({
      applicationId: APP,
      dashboardUrl: DASHBOARD,
      users: { resolve: async () => null },
      guildState: { get: async () => null },
    });

    const before = Date.now();
    const now = env.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});
