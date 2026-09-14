import { describe, expect, test } from 'bun:test';
import type {
  ActionExecutor,
  ActionRequest,
  ActionResult,
  Logger,
  ProtonEvent,
} from '@proton/core';
import { substitute } from '@proton/core';
import {
  type BotFacts,
  definitionsFor,
  type PlaceholderEnvironment,
  type PlaceholderSurface,
  renderTemplate,
  SAMPLE_BOT,
  SAMPLE_NOW,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import {
  DEFAULT_BOOST_GREETING,
  DEFAULT_GOODBYE_GREETING,
  DEFAULT_WELCOME_GREETING,
  type GreetingMessage,
  greetingMessageSchema,
  type WelcomeConfig,
  welcomeConfigSchema,
  welcomeDefaultConfig,
} from '../src/config.ts';
import { welcomeModule } from '../src/index.ts';
import {
  createBoostListener,
  createGreetingListener,
  type GuildSummary,
  readBoosterTarget,
  readGreetingFacts,
  readGreetingTarget,
} from '../src/listeners.ts';
import {
  type GreetingOccasion,
  type GreetingPlaceholderFacts,
  renderGreetingMessage,
  WELCOME_BOOST_SURFACE,
  WELCOME_JOIN_SURFACE,
  WELCOME_LEAVE_SURFACE,
  welcomeTemplates,
} from '../src/placeholders.ts';

const GUILD = '900000000000000001';
const CHANNEL = '500000000000000001';
const OTHER_CHANNEL = '500000000000000002';
const MEMBER = '100000000000000002';
const ZERO_WIDTH_SPACE = '​';
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';

const SURFACES = {
  join: WELCOME_JOIN_SURFACE,
  leave: WELCOME_LEAVE_SURFACE,
  boost: WELCOME_BOOST_SURFACE,
} as const;

const OCCASIONS: readonly GreetingOccasion[] = ['join', 'leave', 'boost'];

const EVENT_TYPES = {
  join: 'member.joined',
  leave: 'member.left',
  boost: 'message.created',
} as const;

interface Scenario {
  name: string;
  user: Readonly<Record<string, unknown>>;
  nick?: string | null;
  guild: { name: string; memberCount: number } | null;
}

const NORMAL: Scenario = {
  name: 'normal',
  user: { username: 'newcomer', global_name: 'Newcomer' },
  guild: { name: 'Proton', memberCount: 42 },
};

const NICKNAMED: Scenario = {
  name: 'a nickname in the payload',
  user: { username: 'newcomer', global_name: 'Newcomer' },
  nick: 'Sparkle',
  guild: { name: 'Proton', memberCount: 42 },
};

const SCENARIOS: readonly Scenario[] = [
  NORMAL,
  {
    name: 'markdown-hostile',
    user: { username: 'newcomer', global_name: '_New*comer*_ `x` <@1> [a](b) {server}' },
    guild: { name: '**Proton** {user} # not a heading', memberCount: 0 },
  },
  {
    name: 'empty name',
    user: { username: 'newcomer', global_name: '' },
    guild: { name: 'P'.repeat(300), memberCount: 1_234_567 },
  },
  {
    name: 'no display name, a null nick and no guild state',
    user: { username: 'newcomer', global_name: null },
    nick: null,
    guild: null,
  },
  {
    name: 'no names at all and an empty nick',
    user: {},
    nick: '',
    guild: { name: 'Proton', memberCount: 42 },
  },
  NICKNAMED,
];

function payloadFor(occasion: GreetingOccasion, scenario: Scenario): Record<string, unknown> {
  const user = { id: MEMBER, avatar: null, ...scenario.user };
  const member = {
    roles: [],
    joined_at: '2026-09-14T09:00:00.000000+00:00',
    ...(scenario.nick === undefined ? {} : { nick: scenario.nick }),
  };

  if (occasion === 'boost') {
    return {
      id: '1400000000000000001',
      type: 8,
      guild_id: GUILD,
      channel_id: CHANNEL,
      author: user,
      member,
    };
  }
  if (occasion === 'leave') return { guild_id: GUILD, user };

  return { guild_id: GUILD, user, ...member };
}

function eventFor(occasion: GreetingOccasion, payload: unknown, id = `${occasion}-1`): ProtonEvent {
  return { id, type: EVENT_TYPES[occasion], guildId: GUILD, occurredAt: SAMPLE_NOW, payload };
}

function factsFor(occasion: GreetingOccasion, scenario: Scenario): GreetingPlaceholderFacts {
  const read = readGreetingFacts({ payload: payloadFor(occasion, scenario) }, occasion);
  if (read === null) throw new Error('the payload carried no user');

  return {
    user: read.user,
    member: read.member,
    server: scenario.guild === null ? null : { id: GUILD, ...scenario.guild },
    ...(read.channelId === null ? {} : { channel: { id: read.channelId } }),
    destinationChannel: { id: CHANNEL },
    bot: null,
    eventId: `${occasion}-1`,
    occurredAt: SAMPLE_NOW,
  };
}

function greeting(value: unknown): GreetingMessage {
  return greetingMessageSchema.parse(value);
}

function render(
  occasion: GreetingOccasion,
  message: GreetingMessage,
  facts: GreetingPlaceholderFacts,
): GreetingMessage {
  const rendered = renderGreetingMessage(message, SURFACES[occasion], facts, SAMPLE_NOW);
  if (!rendered.ok) throw new Error(rendered.humanReason);
  return rendered.message;
}

function legacy(
  occasion: GreetingOccasion,
  scenario: Scenario,
  message: GreetingMessage,
): GreetingMessage {
  const payload = payloadFor(occasion, scenario);
  const guild = scenario.guild ?? {};
  const target =
    occasion === 'boost' ? readBoosterTarget(payload, guild) : readGreetingTarget(payload, guild);
  if (target === null) throw new Error('the payload carried no user');

  return substitute(message, {
    user: `<@${target.userId}>`,
    username: target.username,
    server: target.guildName,
    memberCount: String(target.memberCount),
  }) as GreetingMessage;
}

function textFields(message: GreetingMessage): Record<string, string | undefined> {
  const embed = message.embeds[0];
  const field = embed?.fields?.[0];
  const texts: Record<string, string | undefined> = {
    content: message.content,
    title: embed?.title,
    description: embed?.description,
    fieldName: field?.name,
    fieldValue: field?.value,
  };

  for (const [index, component] of message.v2.entries()) {
    if (component.kind === 'text') texts[`v2.${index}`] = component.content;
    if (component.kind === 'section') {
      for (const [at, line] of component.text.entries()) texts[`v2.${index}.${at}`] = line;
    }
    if (component.kind === 'container') {
      for (const [at, child] of component.children.entries()) {
        if (child.kind === 'text') texts[`v2.${index}.children.${at}`] = child.content;
      }
    }
  }

  return texts;
}

function buttonsOf(
  message: GreetingMessage,
): Array<{ label?: string | undefined; url?: string | undefined }> {
  const row = message.components[0];
  return row?.kind === 'buttons' ? row.buttons : [];
}

function codesAt(
  report: { byPath: ReadonlyMap<string, ReadonlyArray<{ code: string }>> },
  path: string,
): string[] {
  return (report.byPath.get(path) ?? []).map(({ code }) => code);
}

function pickerKeys(surface: PlaceholderSurface<GreetingPlaceholderFacts>): string[] {
  return definitionsFor(surface.registry, {
    field: 'discord_text',
    event: surface.event,
    audience: surface.audience,
  }).map(({ key }) => key);
}

const CONTENT_TEMPLATES = [
  'Welcome to {server}, {user}. You are member #{memberCount}.',
  '{username} has left {server}.',
  'Thanks for boosting **{server}**, {user}!',
  '{user} {username} {server} {memberCount}',
  'hello {nobody}',
  'hello {constructor} {toString} {__proto__}',
  '{user.nmae} and {Server} and {member-count}',
  'a { lone } brace for {user} with {} and { server }',
  '{user}{user}{server}{memberCount}',
  '',
  'no placeholders at all',
];

const EMBED_GREETING = {
  embeds: [
    {
      title: '{username} is member #{memberCount}, {user}',
      description:
        'Welcome to {server}, {user}. {username} makes {memberCount}. {nobody} {constructor}',
      fields: [
        { name: 'Who: {username}', value: '{server} now has {memberCount} members, {user}' },
      ],
    },
  ],
};

const LAYOUT_GREETING = {
  v2: [
    { kind: 'text', content: 'Welcome to {server}, {user}!' },
    {
      kind: 'section',
      text: ['Name: {username}', 'Member #{memberCount} of {server}'],
      accessory: { kind: 'thumbnail', url: 'https://cdn.discordapp.com/embed/avatars/0.png' },
    },
    { kind: 'container', children: [{ kind: 'text', content: '{username} | {server}' }] },
  ],
};

describe('legacy greetings render byte-identically outside links', () => {
  const messages = [
    ...CONTENT_TEMPLATES.map((content) => greeting(content)),
    greeting(EMBED_GREETING),
    greeting(LAYOUT_GREETING),
  ];

  for (const occasion of OCCASIONS) {
    for (const scenario of SCENARIOS) {
      test(`${occasion}: ${scenario.name}`, () => {
        const facts = factsFor(occasion, scenario);

        for (const message of messages) {
          expect(textFields(render(occasion, message, facts))).toEqual(
            textFields(legacy(occasion, scenario, message)),
          );
        }
      });
    }
  }
});

describe('intentional changes on greetings', () => {
  test('{user} in an embed footer or author name shows the member’s name, not a raw mention', () => {
    const message = greeting({
      embeds: [{ title: 'Hi', author: { name: '{user} of {server}' }, footer: { text: '{user}' } }],
    });

    const next = render('join', message, factsFor('join', NORMAL)).embeds[0];
    const before = legacy('join', NORMAL, message).embeds[0];

    expect(next?.author?.name).toBe('Newcomer of Proton');
    expect(before?.author?.name).toBe(`<@${MEMBER}> of Proton`);
    expect(next?.footer?.text).toBe('Newcomer');
  });

  test('{server} in a footer or author name is still byte-identical', () => {
    const hostile = SCENARIOS[1] ?? NORMAL;
    const message = greeting({
      embeds: [{ title: 'Hi', author: { name: '{server}' }, footer: { text: 'From {server}' } }],
    });

    const next = render('join', message, factsFor('join', hostile)).embeds[0];
    const before = legacy('join', hostile, message).embeds[0];

    expect(next?.author?.name).toBe(before?.author?.name ?? '');
    expect(next?.footer?.text).toBe(before?.footer?.text ?? '');
  });

  test('{now} in a footer is a readable date, and a Discord timestamp in message text', () => {
    const message = greeting({
      content: 'Posted {now}',
      embeds: [{ title: 'Hi', footer: { text: 'Posted {now}' } }],
    });

    const rendered = render('join', message, factsFor('join', NORMAL));

    expect(rendered.embeds[0]?.footer?.text).toMatch(/^Posted Sep 14, 2026, 9:00\sAM$/u);
    expect(rendered.embeds[0]?.footer?.text).not.toContain('<t:');
    expect(rendered.content).toBe(`Posted <t:${SAMPLE_NOW / 1000}:f>`);
  });

  test('a legacy name in a link is written link-safe, and {user} there renders as nothing', () => {
    const scenario = { ...NORMAL, guild: { name: 'Proton HQ', memberCount: 42 } };
    const message = greeting({
      content: 'Links',
      components: [
        {
          kind: 'buttons',
          buttons: [
            { key: 'site', style: 'link', label: 'Site', url: 'https://example.com/{server}' },
            { key: 'profile', style: 'link', label: 'Profile', url: 'https://example.com/{user}' },
          ],
        },
      ],
    });

    const rendered = renderGreetingMessage(
      message,
      WELCOME_JOIN_SURFACE,
      factsFor('join', scenario),
      SAMPLE_NOW,
    );
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(buttonsOf(rendered.message).map(({ url }) => url)).toEqual([
      'https://example.com/Proton%20HQ',
      'https://example.com/',
    ]);
    expect(buttonsOf(legacy('join', scenario, message))[0]?.url).toBe(
      'https://example.com/Proton HQ',
    );
    expect(rendered.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'incompatible_field',
        path: 'welcomeMessage.components.0.buttons.1.url',
      }),
    );

    const report = validateConfigTemplates(
      welcomeTemplates,
      welcomeConfigSchema.parse({ welcomeMessage: message }),
    );

    expect(codesAt(report, 'welcomeMessage.components.0.buttons.0.url')).toContain(
      'legacy_alias_in_url',
    );
    expect(codesAt(report, 'welcomeMessage.components.0.buttons.1.url')).toEqual([
      'incompatible_field',
    ]);
  });

  test('a name of @everyone through {username} is broken in message text, but not in a label', () => {
    const scenario = { ...NORMAL, user: { username: 'newcomer', global_name: '@everyone' } };
    const message = greeting({
      content: 'Hi {username}',
      components: [
        {
          kind: 'buttons',
          buttons: [{ key: 'hi', style: 'link', label: '{username}', url: 'https://example.com' }],
        },
      ],
    });

    const next = render('join', message, factsFor('join', scenario));

    expect(next.content).toBe(`Hi @${ZERO_WIDTH_SPACE}everyone`);
    expect(legacy('join', scenario, message).content).toBe('Hi @everyone');
    expect(buttonsOf(next)[0]?.label).toBe('@everyone');
  });
});

describe('who a greeting names', () => {
  test('a boost names the booster by nickname, and a join ignores any nickname', () => {
    expect(
      render('boost', greeting('Thanks {username}'), factsFor('boost', NICKNAMED)).content,
    ).toBe('Thanks Sparkle');
    expect(render('join', greeting('Hi {username}'), factsFor('join', NICKNAMED)).content).toBe(
      'Hi Newcomer',
    );
  });

  test('{user.nickname} on a goodbye renders as nothing, says why, and is not offered', () => {
    const rendered = renderGreetingMessage(
      greeting('Bye {user.nickname}!'),
      WELCOME_LEAVE_SURFACE,
      factsFor('leave', NICKNAMED),
      SAMPLE_NOW,
    );
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(rendered.message.content).toBe('Bye !');
    expect(rendered.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unavailable', path: 'goodbyeMessage.content' }),
    );
    expect(pickerKeys(WELCOME_LEAVE_SURFACE)).not.toContain('user.nickname');
    expect(
      WELCOME_LEAVE_SURFACE.pickerFor('goodbyeMessage.content').map(({ key }) => key),
    ).not.toContain('user.nickname');
    expect(pickerKeys(WELCOME_JOIN_SURFACE)).toContain('user.nickname');
    expect(pickerKeys(WELCOME_BOOST_SURFACE)).toContain('user.nickname');
  });

  test('a changed goodbye that uses a member-only placeholder is refused, naming the field', () => {
    const report = validateConfigTemplates(
      welcomeTemplates,
      welcomeConfigSchema.parse({ goodbyeMessage: 'Bye {user.nickname}' }),
      welcomeDefaultConfig,
    );

    expect(report.blocking.map(({ path }) => path)).toEqual(['goodbyeMessage.content']);
  });

  test('the user id in a payload never comes from an inherited or __proto__ key', () => {
    const payload = JSON.parse(
      `{"guild_id":"${GUILD}","user":{"id":"${MEMBER}","__proto__":{"global_name":"Hijacked"}}}`,
    );
    const read = readGreetingFacts({ payload }, 'join');

    expect(read?.user.globalName).toBeNull();
    expect(read?.user.username).toBeNull();
    expect(readGreetingFacts({ payload: { guild_id: GUILD, user: {} } }, 'join')).toBeNull();
  });
});

describe('what a greeting never renders', () => {
  test('a button key and an emoji name are left exactly as stored', () => {
    const message: GreetingMessage = {
      content: 'Hi {user}',
      embeds: [],
      components: [
        {
          kind: 'buttons',
          buttons: [
            {
              key: '{user}',
              style: 'link',
              label: 'Rules',
              url: 'https://example.com',
              emoji: { name: '{server}' },
            },
          ],
        },
      ],
      mentions: { everyone: false, roles: true, users: true },
      v2: [],
    };

    const next = render('join', message, factsFor('join', NORMAL));
    const row = next.components[0];
    const button = row?.kind === 'buttons' ? row.buttons[0] : undefined;
    const before = legacy('join', NORMAL, message).components[0];

    expect(next.content).toBe(`Hi <@${MEMBER}>`);
    expect(button?.key).toBe('{user}');
    expect(button?.emoji?.name).toBe('{server}');
    expect(before?.kind === 'buttons' ? before.buttons[0]?.key : undefined).toBe(`<@${MEMBER}>`);
  });

  test('a member’s name holding markup is escaped through a canonical key and never re-expanded', () => {
    const scenario = {
      ...NORMAL,
      user: { username: 'newcomer', global_name: '{server} <@&100000000000000020> **x**' },
    };

    const content =
      render('join', greeting('Hi {user.global_name}'), factsFor('join', scenario)).content ?? '';

    expect(content).toBe('Hi {server} \\<@&100000000000000020\\> \\*\\*x\\*\\*');
    expect(content).not.toMatch(/(?<!\\)<@&/);
    expect(content).not.toContain('Proton');
  });

  test('prototype names are posted as written', () => {
    const template = 'x {constructor} {__proto__} {user.constructor} {toString} {user.__proto__}';
    const rendered = renderGreetingMessage(
      greeting(template),
      WELCOME_JOIN_SURFACE,
      factsFor('join', NORMAL),
      SAMPLE_NOW,
    );
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(rendered.message.content).toBe(template);
    expect(rendered.diagnostics.map(({ code }) => code)).toContain('forbidden_key');
  });

  test('every placeholder on a greeting is public, so nothing private reaches a server channel', () => {
    for (const surface of Object.values(SURFACES)) {
      expect(surface.audience).toBe('public');
      expect(surface.definitions.filter(({ sensitivity }) => sensitivity !== 'public')).toEqual([]);
    }
  });
});

describe('Discord’s limits on a rendered greeting', () => {
  function withServer(name: string): GreetingPlaceholderFacts {
    return factsFor('join', { ...NORMAL, guild: { name, memberCount: 1 } });
  }

  test('a 300-character server name in an embed title is cut to 256', () => {
    const rendered = renderGreetingMessage(
      greeting({ embeds: [{ title: '{server}' }] }),
      WELCOME_JOIN_SURFACE,
      withServer('P'.repeat(300)),
      SAMPLE_NOW,
    );
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(rendered.message.embeds[0]?.title).toBe('P'.repeat(256));
    expect(rendered.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'output_truncated', path: 'welcomeMessage.embeds.0.title' }),
    );
  });

  test('a title of joined emoji is cut on a grapheme boundary, in UTF-16 units', () => {
    const title = render(
      'join',
      greeting({ embeds: [{ title: '{server}' }] }),
      withServer(FAMILY.repeat(200)),
    ).embeds[0]?.title;

    expect(FAMILY).toHaveLength(8);
    expect(title).toBe(FAMILY.repeat(32));
  });

  test('a mention straddling the 2000 cut is dropped whole', () => {
    const content = render(
      'join',
      greeting('{server}{user}'),
      withServer('x'.repeat(1990)),
    ).content;

    expect(content).toBe('x'.repeat(1990));
  });
});

describe('a stored link that holds no placeholders', () => {
  const LONG_LINK = `https://cdn.example.com/${'a'.repeat(2100)}.png`;

  function rendered(message: GreetingMessage) {
    return renderGreetingMessage(
      message,
      WELCOME_JOIN_SURFACE,
      factsFor('join', NORMAL),
      SAMPLE_NOW,
    );
  }

  test('a gallery image and section thumbnails past 2048 characters post exactly as stored', () => {
    const message = greeting({
      v2: [
        { kind: 'text', content: 'Welcome {user}' },
        { kind: 'gallery', items: [{ url: LONG_LINK }] },
        { kind: 'section', text: ['Hi'], accessory: { kind: 'thumbnail', url: LONG_LINK } },
        {
          kind: 'container',
          children: [
            { kind: 'section', text: ['Hi'], accessory: { kind: 'thumbnail', url: LONG_LINK } },
          ],
        },
      ],
    });

    const result = rendered(message);
    if (!result.ok) throw new Error(result.humanReason);

    expect(LONG_LINK.length).toBeGreaterThan(2048);
    expect(result.message.v2[0]).toEqual({ kind: 'text', content: `Welcome <@${MEMBER}>` });
    expect(result.message.v2.slice(1)).toEqual(message.v2.slice(1));
    expect(result.diagnostics.map(({ code }) => code)).not.toContain('invalid_url');
  });

  test('embed and button links the stored shape accepts post as stored, whatever characters they hold', () => {
    const message = greeting({
      embeds: [
        {
          title: 'Hi',
          imageUrl: 'https://cdn.example.com/my image.png',
          thumbnailUrl: 'https://cdn.example.com/a"b.png',
          author: { name: 'Proton', iconUrl: 'https://cdn.example.com/{a b}<c>.png' },
        },
      ],
      components: [
        {
          kind: 'buttons',
          buttons: [
            { key: 'rules', style: 'link', label: 'Rules', url: 'https://example.com/our rules' },
          ],
        },
      ],
    });

    const result = rendered(message);
    if (!result.ok) throw new Error(result.humanReason);

    expect(result.message.embeds).toEqual(message.embeds);
    expect(result.message.components).toEqual(message.components);
    expect(result.diagnostics.map(({ code }) => code)).toContain('lone_brace');
    expect(result.diagnostics.map(({ code }) => code)).not.toContain('invalid_url');
  });

  test('doubled braces in a link are still read as the template escape', () => {
    const result = rendered(
      greeting({
        v2: [{ kind: 'gallery', items: [{ url: 'https://cdn.example.com/{{x}}.png' }] }],
      }),
    );
    if (!result.ok) throw new Error(result.humanReason);

    const [gallery] = result.message.v2;
    expect(gallery?.kind === 'gallery' ? gallery.items[0]?.url : undefined).toBe(
      'https://cdn.example.com/{x}.png',
    );
  });

  test('a link that holds a placeholder is still refused when it does not come out as a link', () => {
    for (const url of [
      `https://cdn.example.com/${'a'.repeat(2100)}/{user.id}.png`,
      'https://cdn.example.com/{user.id} avatar.png',
    ]) {
      const result = rendered(greeting({ v2: [{ kind: 'gallery', items: [{ url }] }] }));
      if (result.ok) throw new Error(`${url} rendered, but it should have been refused`);

      expect(result.humanReason).toContain('welcomeMessage.v2.0.items.0.url (Image)');
      expect(result.humanReason).toContain('It uses {user.id}.');
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'invalid_url', path: 'welcomeMessage.v2.0.items.0.url' }),
      );
    }
  });
});

describe('ping warnings', () => {
  function report(config: Record<string, unknown>) {
    return validateConfigTemplates(
      welcomeTemplates,
      welcomeConfigSchema.parse(config),
      welcomeDefaultConfig,
    );
  }

  const quiet = (kind: 'roles' | 'users') => ({
    everyone: false,
    roles: kind !== 'roles',
    users: kind !== 'users',
  });

  test('{user.role_mentions} warns while role pings are allowed, and never blocks', () => {
    const allowed = report({ welcomeMessage: 'Your roles: {user.role_mentions}' });

    expect(codesAt(allowed, 'welcomeMessage.content')).toContain('may_ping');
    expect(allowed.blocking).toEqual([]);

    const off = report({
      welcomeMessage: { content: 'Your roles: {user.role_mentions}', mentions: quiet('roles') },
    });

    expect(codesAt(off, 'welcomeMessage.content')).not.toContain('may_ping');
  });

  test('{server.owner_mention} warns while user pings are allowed, and never blocks', () => {
    const allowed = report({ boostMessage: 'Owner: {server.owner_mention}' });

    expect(codesAt(allowed, 'boostMessage.content')).toContain('may_ping');
    expect(allowed.blocking).toEqual([]);

    const off = report({
      boostMessage: { content: 'Owner: {server.owner_mention}', mentions: quiet('users') },
    });

    expect(codesAt(off, 'boostMessage.content')).not.toContain('may_ping');
  });
});

describe('the three greeting surfaces', () => {
  test('each claims the four legacy names exactly once', () => {
    for (const surface of Object.values(SURFACES)) {
      expect(surface.definitions.flatMap(({ aliases }) => aliases).sort()).toEqual([
        'memberCount',
        'server',
        'user',
        'username',
      ]);
      expect(surface.registry.resolve('user')?.canonical).toBe('user.mention');
      expect(surface.registry.resolve('server')?.canonical).toBe('server.name');
      expect(surface.registry.resolve('memberCount')?.canonical).toBe('server.member_count');
    }
  });

  test('{username} is the account’s display name on join and leave, and the server name on boost', () => {
    expect(WELCOME_JOIN_SURFACE.registry.resolve('username')?.canonical).toBe('user.global_name');
    expect(WELCOME_LEAVE_SURFACE.registry.resolve('username')?.canonical).toBe('user.global_name');
    expect(WELCOME_BOOST_SURFACE.registry.resolve('username')?.canonical).toBe('user.display_name');
  });

  test('the channel of the boost notice is offered on boosts only, and event.id nowhere', () => {
    expect(WELCOME_BOOST_SURFACE.registry.resolve('channel.mention')).toBeDefined();
    expect(WELCOME_JOIN_SURFACE.registry.resolve('channel.mention')).toBeUndefined();
    expect(WELCOME_LEAVE_SURFACE.registry.resolve('channel.mention')).toBeUndefined();

    for (const surface of Object.values(SURFACES)) {
      expect(surface.registry.resolve('destination_channel.mention')).toBeDefined();
      expect(surface.registry.resolve('bot.name')).toBeDefined();
      expect(surface.registry.resolve('event.created_at')).toBeDefined();
      expect(surface.registry.resolve('event.id')).toBeUndefined();
      expect(surface.registry.resolve('year')).toBeDefined();
    }
  });

  test('each sample renders the shipped default, with its caption', () => {
    const defaults = {
      join: DEFAULT_WELCOME_GREETING,
      leave: DEFAULT_GOODBYE_GREETING,
      boost: DEFAULT_BOOST_GREETING,
    };
    const expected = {
      join: 'Welcome to Proton HQ, <@100000000000000010>. You are member #1204.',
      leave: 'Fraimer has left Proton HQ.',
      boost: 'Thanks for boosting **Proton HQ**, <@100000000000000010>!',
    };

    for (const occasion of OCCASIONS) {
      const sample = SURFACES[occasion].samples[0];
      if (sample === undefined) throw new Error(`${occasion} has no sample`);

      expect(render(occasion, defaults[occasion], sample.facts).content).toBe(expected[occasion]);
    }

    expect(WELCOME_JOIN_SURFACE.samples[0]?.label).toBe('Sample: Fraimer joining Proton HQ');
  });

  test('the manifest carries the templates, and collect finds each message’s fields', () => {
    expect(welcomeModule.templates).toBe(welcomeTemplates);
    expect(Object.keys(welcomeTemplates.surfaces).sort()).toEqual([
      'welcome.boost',
      'welcome.join',
      'welcome.leave',
    ]);

    const sites = welcomeTemplates.collect(
      welcomeConfigSchema.parse({ welcomeMessage: EMBED_GREETING, goodbyeMessage: 'Bye' }),
    );

    expect(sites.map(({ path, surfaceId }) => `${surfaceId} ${path}`)).toEqual([
      'welcome.join welcomeMessage.embeds.0.title',
      'welcome.join welcomeMessage.embeds.0.description',
      'welcome.join welcomeMessage.embeds.0.fields.0.name',
      'welcome.join welcomeMessage.embeds.0.fields.0.value',
      'welcome.leave goodbyeMessage.content',
      'welcome.boost boostMessage.content',
    ]);
  });

  test('collect never throws on a config of the wrong shape', () => {
    for (const garbage of [null, 'x', 5, [], { welcomeMessage: 5 }, { boostMessage: [null] }]) {
      expect(welcomeTemplates.collect(garbage)).toEqual([]);
    }
  });

  test('a stored {user:shout} still parses, renders as the engine does, and blocks no toggle', () => {
    const stored = welcomeConfigSchema.parse({ welcomeMessage: 'Hi {user:shout}' });
    const facts = factsFor('join', NORMAL);
    const rendered = renderGreetingMessage(
      stored.welcomeMessage,
      WELCOME_JOIN_SURFACE,
      facts,
      SAMPLE_NOW,
    );
    const engine = renderTemplate(
      'Hi {user:shout}',
      WELCOME_JOIN_SURFACE.build(facts, { now: SAMPLE_NOW }),
      {
        registry: WELCOME_JOIN_SURFACE.registry,
        field: 'discord_text',
        event: WELCOME_JOIN_SURFACE.event,
        audience: WELCOME_JOIN_SURFACE.audience,
        now: SAMPLE_NOW,
      },
    );

    expect(rendered.ok && rendered.message.content).toBe(engine.output);

    const toggled = welcomeConfigSchema.parse({ ...stored, enabled: true });

    expect(validateConfigTemplates(welcomeTemplates, toggled, stored).blocking).toEqual([]);
    expect(validateConfigTemplates(welcomeTemplates, toggled).blocking.length).toBeGreaterThan(0);
  });
});

class RecordingExecutor implements ActionExecutor {
  readonly requests: ActionRequest[] = [];

  async execute(request: ActionRequest): Promise<ActionResult> {
    this.requests.push(request);
    return { status: 'executed', caseId: 'case-1' };
  }
}

function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    },
  };
}

function config(overrides: Record<string, unknown> = {}): WelcomeConfig {
  return welcomeConfigSchema.parse({
    enabled: true,
    welcomeChannelId: CHANNEL,
    goodbyeChannelId: CHANNEL,
    boostEnabled: true,
    ...overrides,
  });
}

function sent(executor: RecordingExecutor, index = 0): Record<string, unknown> {
  const request = executor.requests[index];
  if (!request) throw new Error(`action ${index + 1} was not executed`);
  return (request.payload ?? {}) as Record<string, unknown>;
}

function environment(bot: () => Promise<BotFacts>, now = SAMPLE_NOW): PlaceholderEnvironment {
  return {
    applicationId: SAMPLE_BOT.id,
    bot,
    server: async (guildId) => ({ id: guildId }),
    user: async () => null,
    now: () => now,
  };
}

describe('the greeting listeners', () => {
  test('a greeting that cannot be sent once filled in posts nothing, and names the field', async () => {
    const executor = new RecordingExecutor();
    const { logger, lines } = collectingLogger();

    await createGreetingListener().handler(eventFor('join', payloadFor('join', NORMAL)), {
      guildId: GUILD,
      config: config({
        welcomeMessage: {
          content: 'Hi',
          components: [
            {
              kind: 'buttons',
              buttons: [
                {
                  key: 'go',
                  style: 'link',
                  label: '{user.nickname}',
                  url: 'https://example.com',
                },
              ],
            },
          ],
        },
      }),
      executor,
      logger,
    });

    expect(executor.requests).toEqual([]);
    expect(lines.join(' ')).toContain('welcomeMessage.components.0.buttons.0.label');
    expect(lines.join(' ')).toContain('{user.nickname}');
  });

  test('Proton’s own profile is read only when the message uses one of its placeholders', async () => {
    let reads = 0;
    const executor = new RecordingExecutor();
    const listener = createGreetingListener({
      placeholders: environment(async () => {
        reads += 1;
        return SAMPLE_BOT;
      }),
    });
    const payload = payloadFor('join', NORMAL);

    await listener.handler(eventFor('join', payload, 'join-1'), {
      guildId: GUILD,
      config: config(),
      executor,
      logger: collectingLogger().logger,
    });

    expect(reads).toBe(0);

    await listener.handler(eventFor('join', payload, 'join-2'), {
      guildId: GUILD,
      config: config({ welcomeMessage: 'Say hi to {bot.name}' }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(reads).toBe(1);
    expect(sent(executor, 1).content).toBe('Say hi to Proton');
  });

  test('a profile read that throws still greets, and says why the name is missing', async () => {
    const executor = new RecordingExecutor();
    const { logger, lines } = collectingLogger();
    const listener = createGreetingListener({
      placeholders: environment(async () => {
        throw new Error('profile cache offline');
      }),
    });

    await listener.handler(eventFor('join', payloadFor('join', NORMAL)), {
      guildId: GUILD,
      config: config({ welcomeMessage: 'Say hi to {bot.name}' }),
      executor,
      logger,
    });

    expect(sent(executor).content).toBe('Say hi to');
    expect(lines.join(' ')).toContain('profile cache offline');
  });

  test('{year} follows the placeholder clock', async () => {
    const executor = new RecordingExecutor();
    const listener = createGreetingListener({
      placeholders: environment(async () => SAMPLE_BOT, Date.UTC(2030, 0, 1)),
    });

    await listener.handler(eventFor('join', payloadFor('join', NORMAL)), {
      guildId: GUILD,
      config: config({ welcomeMessage: 'Class of {year}' }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(sent(executor).content).toBe('Class of 2030');
  });

  test('channel names and server counts come from the guild-state cache', async () => {
    const executor = new RecordingExecutor();
    const guild: GuildSummary = {
      name: 'Proton',
      memberCount: 42,
      everyoneRoleId: GUILD,
      roles: new Map([
        [GUILD, {}],
        ['700000000000000001', {}],
      ]),
      channels: new Map([
        [CHANNEL, { type: 0, name: 'welcome', parentId: null }],
        ['500000000000000003', { type: 4, name: 'Community', parentId: null }],
      ]),
    };

    await createGreetingListener({ guildState: { get: async () => guild } }).handler(
      eventFor('join', payloadFor('join', NORMAL)),
      {
        guildId: GUILD,
        config: config({
          welcomeMessage:
            '{destination_channel.name} {destination_channel.mention} {server.role_count} {server.channel_count}',
        }),
        executor,
        logger: collectingLogger().logger,
      },
    );

    expect(sent(executor).content).toBe(`welcome <#${CHANNEL}> 1 1`);
  });

  test('with no guild-state cache the default welcome falls back exactly as before', async () => {
    const executor = new RecordingExecutor();

    await createGreetingListener().handler(eventFor('join', payloadFor('join', NORMAL)), {
      guildId: GUILD,
      config: config(),
      executor,
      logger: collectingLogger().logger,
    });

    expect(sent(executor).content).toBe(`Welcome to this server, <@${MEMBER}>. You are member #0.`);
  });

  test('a goodbye with a member-only placeholder still posts, with it left empty', async () => {
    const executor = new RecordingExecutor();

    await createGreetingListener().handler(eventFor('leave', payloadFor('leave', NICKNAMED)), {
      guildId: GUILD,
      config: config({ goodbyeMessage: '{username} left. Nick: {user.nickname}' }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(sent(executor).content).toBe('Newcomer left. Nick:');
  });

  test('the idempotency keys are unchanged', async () => {
    const executor = new RecordingExecutor();
    const ctx = { guildId: GUILD, config: config(), executor, logger: collectingLogger().logger };

    await createGreetingListener().handler(eventFor('join', payloadFor('join', NORMAL)), ctx);
    await createGreetingListener().handler(eventFor('leave', payloadFor('leave', NORMAL)), ctx);
    await createBoostListener().handler(eventFor('boost', payloadFor('boost', NORMAL)), ctx);

    expect(executor.requests.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      'join-1:greeting',
      'leave-1:greeting',
      'boost-1:boost',
    ]);
  });

  test('a boost can name the channel Discord posted its notice in, apart from where it posts', async () => {
    const executor = new RecordingExecutor();

    await createBoostListener().handler(eventFor('boost', payloadFor('boost', NICKNAMED)), {
      guildId: GUILD,
      config: config({
        boostChannelId: OTHER_CHANNEL,
        boostMessage:
          '{username} boosted in {channel.mention}; posted in {destination_channel.mention}',
      }),
      executor,
      logger: collectingLogger().logger,
    });

    expect(sent(executor).channelId).toBe(OTHER_CHANNEL);
    expect(sent(executor).content).toBe(
      `Sparkle boosted in <#${CHANNEL}>; posted in <#${OTHER_CHANNEL}>`,
    );
  });
});
