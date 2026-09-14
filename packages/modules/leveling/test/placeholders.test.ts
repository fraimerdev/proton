import { describe, expect, test } from 'bun:test';
import { substitute, toDiscordMessage } from '@proton/core';
import {
  definitionsFor,
  renderTemplate,
  SAMPLE_LEVEL_UP,
  SAMPLE_NOW,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import { levelUpCustomId } from '../src/component-id.ts';
import {
  DEFAULT_LEVEL_UP,
  type LevelUpMessage,
  levelingConfigSchema,
  levelingDefaultConfig,
  levelUpMessageSchema,
} from '../src/config.ts';
import { levelProgress, MAX_LEVEL, MAX_XP } from '../src/curve.ts';
import { levelingModule } from '../src/index.ts';
import { renderLevelUpMessage } from '../src/level-up.ts';
import {
  LEVEL_UP_SURFACE,
  type LevelUpPlaceholderFacts,
  levelingTemplates,
} from '../src/placeholders.ts';

const GUILD = '100000000000000001';
const CHANNEL = '800000000000000001';
const USER = '900000000000000002';
const ZERO_WIDTH_SPACE = '​';
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';

function facts(overrides: Partial<LevelUpPlaceholderFacts> = {}): LevelUpPlaceholderFacts {
  return {
    userId: USER,
    user: { id: USER, username: 'member', globalName: 'Member', avatarHash: null },
    member: 'unavailable',
    level: 5,
    previousLevel: 4,
    xp: 1234,
    source: 'message',
    server: { id: GUILD },
    destinationChannel: { id: CHANNEL },
    bot: null,
    ...overrides,
  };
}

function named(globalName: string): LevelUpPlaceholderFacts {
  return facts({ user: { id: USER, username: 'member', globalName, avatarHash: null } });
}

function parse(message: unknown): LevelUpMessage {
  return levelUpMessageSchema.parse(message);
}

function render(message: unknown, given: LevelUpPlaceholderFacts = facts()) {
  const rendered = renderLevelUpMessage(parse(message), given, SAMPLE_NOW);
  if (!rendered.ok) throw new Error(rendered.humanReason);
  return rendered;
}

function content(message: unknown, given: LevelUpPlaceholderFacts = facts()): string | undefined {
  return render(message, given).body.content;
}

function legacy(message: unknown, values: { level: number; xp: number }): unknown {
  const body = toDiscordMessage(parse(message), {
    customIdFor: levelUpCustomId,
    now: new Date(SAMPLE_NOW),
  });
  return substitute(body, { user: `<@${USER}>`, level: values.level, xp: values.xp });
}

function stringsAt(node: unknown, key: string, at = ''): string[] {
  if (typeof node === 'string') return at === key ? [node] : [];
  if (Array.isArray(node)) return node.flatMap((item) => stringsAt(item, key, at));
  if (typeof node !== 'object' || node === null) return [];

  return Object.entries(node).flatMap(([name, value]) => stringsAt(value, key, name));
}

function texts(body: unknown): string[] {
  return ['content', 'title', 'description'].flatMap((key) =>
    stringsAt(body, key).map((text) => `${key}: ${text}`),
  );
}

function codesAt(
  report: { byPath: ReadonlyMap<string, ReadonlyArray<{ code: string }>> },
  path: string,
): string[] {
  return (report.byPath.get(path) ?? []).map(({ code }) => code);
}

const LEVEL_UP_TEMPLATES = [
  '{user} reached level {level}.',
  'GG {user}, level {level} at {xp} XP!',
  '{rank} of {level}',
  'Level {level}',
  '{user} is on {xp} XP.',
  '{xp} XP',
];

function shapes(template: string): unknown[] {
  return [
    template,
    { embeds: [{ title: template, description: template }] },
    {
      v2: [
        { kind: 'text', content: template },
        { kind: 'container', children: [{ kind: 'text', content: template }] },
      ],
    },
  ];
}

describe('legacy level-up messages render byte-identically outside links', () => {
  for (const values of [
    { level: 5, xp: 1234 },
    { level: 0, xp: 0 },
    { level: 100, xp: Number.MAX_SAFE_INTEGER },
  ]) {
    test(`{user} {level} {xp} at level ${values.level}`, () => {
      const given = facts({ level: values.level, previousLevel: values.level - 1, xp: values.xp });

      for (const template of LEVEL_UP_TEMPLATES) {
        for (const message of shapes(template)) {
          const next = texts(render(message, given).body);

          expect(next.length).toBeGreaterThan(0);
          expect(next).toEqual(texts(legacy(message, values)));
        }
      }
    });
  }
});

describe('intentional changes on level-up messages', () => {
  const LINKS = {
    content: 'GG',
    components: [
      {
        kind: 'buttons',
        buttons: [
          {
            key: 'rank',
            style: 'link',
            label: '{user} hit {level} at {xp}',
            url: 'https://example.com/{level}',
          },
          { key: 'me', style: 'link', label: 'Me', url: 'https://example.com/{user}' },
        ],
      },
    ],
  };

  test('{level} and {xp} in a link label are unchanged, and {user} there shows the member’s name', () => {
    expect(stringsAt(render(LINKS).body, 'label')).toEqual(['Member hit 5 at 1234', 'Me']);
    expect(stringsAt(legacy(LINKS, { level: 5, xp: 1234 }), 'label')).toEqual([
      `<@${USER}> hit 5 at 1234`,
      'Me',
    ]);
  });

  test('{level} in a link stays digits, and {user} there renders as nothing and says so', () => {
    const rendered = render(LINKS);

    expect(stringsAt(rendered.body, 'url')).toEqual([
      'https://example.com/5',
      'https://example.com/',
    ]);
    expect(rendered.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'incompatible_field',
        path: 'levelUpMessage.components.0.buttons.1.url',
      }),
    );

    const report = validateConfigTemplates(
      levelingTemplates,
      levelingConfigSchema.parse({ levelUpMessage: LINKS }),
    );

    expect(codesAt(report, 'levelUpMessage.components.0.buttons.1.url')).toEqual([
      'incompatible_field',
    ]);
  });

  test('a display name of @here is broken in message text', () => {
    expect(content('GG {user.global_name}', named('@here'))).toBe(`GG @${ZERO_WIDTH_SPACE}here`);
    expect(content('GG {user.global_name}', named('@everyone'))).toBe(
      `GG @${ZERO_WIDTH_SPACE}everyone`,
    );
  });

  test('a button key, style and emoji name are never rendered', () => {
    const message: LevelUpMessage = {
      content: 'GG {level}',
      embeds: [],
      components: [
        {
          kind: 'buttons',
          buttons: [
            {
              key: '{level}',
              style: 'link',
              label: 'Level {level}',
              url: 'https://example.com',
              emoji: { name: '{xp}' },
            },
          ],
        },
      ],
      mentions: { everyone: false, roles: true, users: true },
      v2: [],
    };

    const rendered = renderLevelUpMessage(message, facts(), SAMPLE_NOW);
    if (!rendered.ok) throw new Error(rendered.humanReason);

    expect(rendered.body.components).toEqual([
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: 'Level 5',
            emoji: { name: '{xp}' },
            url: 'https://example.com',
          },
        ],
      },
    ]);
    expect(message.components[0]).toMatchObject({ buttons: [{ key: '{level}' }] });
  });
});

describe('level-up values', () => {
  test('the level, what changed and how it was earned', () => {
    expect(
      content(
        '{level.previous} to {level.current} (+{level.gained}), next {level.next}, max {level.is_max}, {xp.gained} XP by {level.source}',
        facts({ previousLevel: 3, gained: 40 }),
      ),
    ).toBe('3 to 5 (+2), next 6, max No, 40 XP by message');
  });

  test('the highest level has no next level and no progress left', () => {
    expect(
      content(
        '{level.next} {level.is_max} {xp.progress_percent} {xp.remaining}',
        facts({ level: MAX_LEVEL, previousLevel: MAX_LEVEL - 1, xp: MAX_XP }),
      ),
    ).toBe(`${MAX_LEVEL} Yes 0% 0`);
  });

  test('rank, activity and the ranked count render when read', () => {
    expect(
      content(
        '{level.rank:ordinal} of {level.ranked_member_count}, {level.messages} messages',
        facts({ rank: { rank: 12, messages: 812, voiceSeconds: 18000 }, rankedMemberCount: 480 }),
      ),
    ).toBe('12th of 480, 812 messages');
  });

  test('a failed rank read renders its fallback and reports resolver_failed', () => {
    const rendered = render(
      'Rank {level.rank:fallback("?")} of {level.ranked_member_count:fallback("many")}',
      facts({ rank: null, rankedMemberCount: null }),
    );

    expect(rendered.body.content).toBe('Rank ? of many');
    expect(rendered.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'resolver_failed', path: 'levelUpMessage.content' }),
    );
  });

  test('a rank that was not read renders as nothing and says it is not available', () => {
    const rendered = render('Rank {level.rank}. Gained {xp.gained}.');

    expect(rendered.body.content).toBe('Rank . Gained .');
    expect(rendered.diagnostics.map(({ code }) => code)).toEqual(['unavailable', 'unavailable']);
  });

  test('reward roles render as role mentions', () => {
    expect(
      content(
        '{level.reward_roles:join(" ")} / {level.removed_roles:join(" ")} / {level.reward_roles:count}',
        facts({
          rewards: {
            granted: ['100000000000000021', '100000000000000023'],
            revoked: ['100000000000000022'],
          },
        }),
      ),
    ).toBe('<@&100000000000000021> <@&100000000000000023> / <@&100000000000000022> / 2');
  });

  test('a member whose profile could not be read keeps {user} but loses their names', () => {
    const rendered = render('{user} {user.display_name}!', facts({ user: null }));

    expect(rendered.body.content).toBe(`<@${USER}> !`);
    expect(rendered.diagnostics.map(({ code }) => code)).toEqual(['resolver_failed']);
  });

  test('member details are unavailable when the level-up carries no member', () => {
    const rendered = render('Nick: {user.nickname:fallback("none")}');

    expect(rendered.body.content).toBe('Nick: none');
    expect(rendered.diagnostics.map(({ code }) => code)).toEqual(['unavailable']);
    expect(
      content(
        'Nick: {user.nickname:fallback("none")}',
        facts({ member: { nick: 'Sparkle', roleIds: [] } }),
      ),
    ).toBe('Nick: Sparkle');
  });

  test('a voice level-up has no origin channel', () => {
    expect(content('In {channel.mention:fallback("voice")}')).toBe('In voice');
    expect(content('In {channel.mention}', facts({ originChannel: { id: CHANNEL } }))).toBe(
      `In <#${CHANNEL}>`,
    );
  });
});

describe('what a level-up message never does', () => {
  test('a member’s name holding placeholders or markup is escaped and never re-expanded', () => {
    expect(content('GG {user.global_name}', named('{xp}'))).toBe('GG {xp}');

    const hostile = content('GG {user.global_name}', named('{level} <@&100000000000000020> **x**'));

    expect(hostile).toBe('GG {level} \\<@&100000000000000020\\> \\*\\*x\\*\\*');
    expect(hostile).not.toMatch(/(?<!\\)<@&/);
  });

  test('prototype names are posted as written', () => {
    const template = 'x {constructor} {__proto__} {user.constructor} {toString} {level.__proto__}';
    const rendered = render(template);

    expect(rendered.body.content).toBe(template);
    expect(rendered.diagnostics.map(({ code }) => code)).toContain('forbidden_key');
  });

  test('every placeholder is public, so nothing private reaches a server channel', () => {
    expect(LEVEL_UP_SURFACE.audience).toBe('public');
    expect(
      LEVEL_UP_SURFACE.definitions.filter(({ sensitivity }) => sensitivity !== 'public'),
    ).toEqual([]);
    expect(
      definitionsFor(LEVEL_UP_SURFACE.registry, {
        field: 'discord_text',
        event: LEVEL_UP_SURFACE.event,
        audience: 'public',
      }),
    ).toHaveLength(LEVEL_UP_SURFACE.definitions.length);
  });
});

describe('Discord’s limits on a rendered level-up message', () => {
  test('a 300-character name in an embed title is cut to 256', () => {
    const rendered = render({ embeds: [{ title: '{user.global_name}' }] }, named('P'.repeat(300)));

    expect(rendered.body.embeds?.[0]?.title).toBe('P'.repeat(256));
    expect(rendered.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'output_truncated', path: 'levelUpMessage.embeds.0.title' }),
    );
  });

  test('a title of joined emoji is cut on a grapheme boundary, in UTF-16 units', () => {
    const title = render({ embeds: [{ title: '{user.global_name}' }] }, named(FAMILY.repeat(200)))
      .body.embeds?.[0]?.title;

    expect(FAMILY).toHaveLength(8);
    expect(title).toBe(FAMILY.repeat(32));
  });

  test('a mention straddling the 2000 cut is dropped whole', () => {
    expect(content('{user.global_name}{user}', named('x'.repeat(1990)))).toBe('x'.repeat(1990));
  });
});

describe('ping warnings', () => {
  function report(levelUpMessage: unknown) {
    return validateConfigTemplates(
      levelingTemplates,
      levelingConfigSchema.parse({ levelUpMessage }),
      levelingDefaultConfig,
    );
  }

  test('{level.reward_roles} warns while role pings are allowed, and never blocks', () => {
    const allowed = report('GG {user}, you earned {level.reward_roles}');

    expect(codesAt(allowed, 'levelUpMessage.content')).toContain('may_ping');
    expect(allowed.blocking).toEqual([]);

    const off = report({
      content: 'GG {user}, you earned {level.reward_roles}',
      mentions: { everyone: false, roles: false, users: true },
    });

    expect(codesAt(off, 'levelUpMessage.content')).not.toContain('may_ping');
  });

  test('{level.removed_roles} warns too, but not when only counted', () => {
    expect(codesAt(report('Lost {level.removed_roles}'), 'levelUpMessage.content')).toContain(
      'may_ping',
    );
    expect(
      codesAt(report('Lost {level.removed_roles:count} roles'), 'levelUpMessage.content'),
    ).not.toContain('may_ping');
  });
});

describe('the level-up surface', () => {
  test('claims {user}, {level} and {xp} exactly once, and nothing else', () => {
    expect(LEVEL_UP_SURFACE.definitions.flatMap(({ aliases }) => aliases).sort()).toEqual([
      'level',
      'user',
      'xp',
    ]);
    expect(LEVEL_UP_SURFACE.registry.resolve('user')?.canonical).toBe('user.mention');
    expect(LEVEL_UP_SURFACE.registry.resolve('level')?.canonical).toBe('level.current');
    expect(LEVEL_UP_SURFACE.registry.resolve('xp')?.canonical).toBe('xp.total');
    expect(LEVEL_UP_SURFACE.registry.resolve('rank')).toBeUndefined();
  });

  test('offers both channels, Proton and the clock, but no event ids', () => {
    for (const key of [
      'channel.name',
      'destination_channel.mention',
      'server.member_count',
      'bot.name',
      'now',
      'user.role_mentions',
      'level.ranked_member_count',
    ]) {
      expect(LEVEL_UP_SURFACE.registry.resolve(key)).toBeDefined();
    }
    expect(LEVEL_UP_SURFACE.registry.resolve('event.id')).toBeUndefined();
  });

  test('a link offers only link-safe values', () => {
    const keys = LEVEL_UP_SURFACE.pickerFor('levelUpMessage.components.0.buttons.0.url').map(
      ({ key }) => key,
    );

    expect(keys).toContain('xp.total');
    expect(keys).toContain('level.current');
    expect(keys).not.toContain('user.mention');
    expect(keys).not.toContain('level.reward_roles');
    expect(keys).not.toContain('xp.progress_percent');
  });

  test('the sample agrees with the XP curve and renders the shipped default', () => {
    expect(levelProgress(SAMPLE_LEVEL_UP.xp)).toEqual({
      level: SAMPLE_LEVEL_UP.level,
      into: 234,
      span: 350,
      remaining: 116,
    });

    const sample = LEVEL_UP_SURFACE.samples[0];
    if (sample === undefined) throw new Error('the level-up surface has no sample');

    expect(sample.label).toBe('Sample: Fraimer reaching level 5 in Proton HQ');
    expect(content('{xp.progress_percent}', sample.facts)).toBe('66.86%');
    expect(content('{xp.into_level}/{xp.level_span}, {xp.remaining} to go', sample.facts)).toBe(
      '234/350, 116 to go',
    );
    expect(content(DEFAULT_LEVEL_UP, sample.facts)).toBe('<@100000000000000010> reached level 5.');
  });

  test('the manifest carries the templates, and collect finds the message fields', () => {
    expect(levelingModule.templates).toBe(levelingTemplates);
    expect(Object.keys(levelingTemplates.surfaces)).toEqual(['leveling.level_up']);

    const sites = levelingTemplates.collect(
      levelingConfigSchema.parse({
        levelUpMessage: { content: 'GG {user}', embeds: [{ title: 'Level {level}' }] },
      }),
    );

    expect(sites.map(({ path, surfaceId }) => `${surfaceId} ${path}`)).toEqual([
      'leveling.level_up levelUpMessage.content',
      'leveling.level_up levelUpMessage.embeds.0.title',
    ]);
  });

  test('collect never throws on a config of the wrong shape', () => {
    for (const garbage of [null, 'x', 5, [], { levelUpMessage: 5 }, { levelUpMessage: [null] }]) {
      expect(levelingTemplates.collect(garbage)).toEqual([]);
    }
  });

  test('a stored {level:shout} still parses, renders as the engine does, and blocks no toggle', () => {
    const stored = levelingConfigSchema.parse({ levelUpMessage: 'GG {level:shout}' });
    const given = facts();
    const engine = renderTemplate(
      'GG {level:shout}',
      LEVEL_UP_SURFACE.build(given, { now: SAMPLE_NOW }),
      {
        registry: LEVEL_UP_SURFACE.registry,
        field: 'discord_text',
        event: LEVEL_UP_SURFACE.event,
        audience: LEVEL_UP_SURFACE.audience,
        now: SAMPLE_NOW,
      },
    );

    expect(content(stored.levelUpMessage, given)).toBe(engine.output.trim());

    const toggled = levelingConfigSchema.parse({ ...stored, enabled: true });

    expect(validateConfigTemplates(levelingTemplates, toggled, stored).blocking).toEqual([]);
    expect(validateConfigTemplates(levelingTemplates, toggled).blocking.length).toBeGreaterThan(0);
  });
});
