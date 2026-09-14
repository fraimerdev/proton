import { describe, expect, test } from 'bun:test';
import type { ChannelState, GuildState } from '@proton/core';
import {
  formatTemplateIssues,
  isRestricted,
  type PlaceholderRequest,
  renderTemplate,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  serverFactsFrom,
  validateConfigTemplates,
} from '@proton/core/placeholders';
import {
  type CountersConfig,
  countersConfigSchema,
  countersDefaultConfig,
  TEMPLATE_MAX,
} from '../src/config.ts';
import { CHANNEL_NAME_MAX, COUNTER_SOURCES } from '../src/constants.ts';
import { createCountersModule } from '../src/index.ts';
import {
  COUNT_KEYS,
  COUNTER_EVENT,
  COUNTER_SURFACE,
  countersTemplates,
  countFor,
  renderCounterName,
} from '../src/placeholders.ts';
import { plan, renderName } from '../src/render.ts';
import {
  COUNTER_A,
  guildState,
  harness,
  MEMBER_COUNT,
  subcommand,
  voiceChannel,
} from './harness.ts';

type CounterEntry = CountersConfig['counters'][number];

const NOW = SAMPLE_NOW;

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';

const FLAG = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function withMembers(count: number): GuildState {
  return { ...guildState(), memberCount: count };
}

function withoutMembers(): GuildState {
  const state: GuildState = { ...guildState() };
  delete state.memberCount;
  return state;
}

function legacyName(template: string, count: number): string {
  return template.split('{count}').join(String(count)).slice(0, 100);
}

function config(counters: CounterEntry[]): CountersConfig {
  return { ...countersDefaultConfig, enabled: true, counters };
}

function pointed(template: string, source: CounterEntry['source'] = 'members'): CounterEntry {
  return { id: COUNTER_A, channelId: COUNTER_A, template, source };
}

function codes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map(({ code }) => code);
}

function sample() {
  const first = COUNTER_SURFACE.samples[0];
  if (!first) throw new Error('the counters surface has no sample');
  return first;
}

describe('a legacy counter name renders byte for byte', () => {
  const templates = [
    'Members: {count}',
    '{count} of {count}',
    '{members} online — {count}',
    'Nothing here',
    `${'x'.repeat(100)}{count}`,
    `${'x'.repeat(93)}{count}`,
    `${FAMILY} Members: {count}`,
    `${FLAG} {count} ❤️ a‌b`,
  ];

  for (const count of [0, 7, 1234, 999_999_999]) {
    test(`through renderName (${count})`, () => {
      for (const template of templates) {
        expect(renderName(template, 'members', withMembers(count), NOW)).toBe(
          legacyName(template, count),
        );
      }
    });

    test(`through plan (${count})`, () => {
      for (const template of templates) {
        const state = withMembers(count);
        state.channels.set(COUNTER_A, voiceChannel(COUNTER_A, 'stale'));

        expect(plan(config([pointed(template)]), state, new Map(), NOW).edits).toEqual([
          { channelId: COUNTER_A, from: 'stale', to: legacyName(template, count) },
        ]);
      }
    });
  }

  test('for every source it counts', () => {
    const state = guildState();

    for (const source of COUNTER_SOURCES) {
      const count = countFor(source, state);
      if (count === null) throw new Error(`the harness has no ${source} count`);

      for (const template of templates) {
        expect(renderName(template, source, state, NOW)).toBe(legacyName(template, count));
      }
    }
  });

  test('a counter Proton makes is born with the legacy name', () => {
    const result = plan(config([{ id: 'c1', template: `${FAMILY} {count}`, source: 'members' }]), {
      ...guildState(),
    });

    expect(result.creations).toEqual([
      { counterId: 'c1', name: legacyName(`${FAMILY} {count}`, MEMBER_COUNT) },
    ]);
  });
});

describe('whitespace in a counter name is tidied, as designed', () => {
  test('surrounding whitespace is trimmed and other whitespace becomes a space', () => {
    const state = withMembers(42);

    expect(legacyName('  Members: {count}  ', 42)).toBe('  Members: 42  ');
    expect(renderName('  Members: {count}  ', 'members', state, NOW)).toBe('Members: 42');
    expect(renderName('Members:\t{count}', 'members', state, NOW)).toBe('Members: 42');
    expect(renderName('Members:\n{count}', 'members', state, NOW)).toBe('Members: 42');
    expect(renderName('Members: {count}', 'members', state, NOW)).toBe('Members: 42');
  });

  test('a name clipped at the channel-name cap loses the space it ended on', () => {
    const template = `${'x'.repeat(99)} {count}`;

    expect(legacyName(template, 42)).toBe(`${'x'.repeat(99)} `);
    expect(renderName(template, 'members', withMembers(42), NOW)).toBe('x'.repeat(99));
  });

  test('the first refresh after the change renames such a counter once, and the next leaves it', () => {
    const state = withMembers(42);
    const counters = config([pointed('  Members: {count}  ')]);
    state.channels.set(COUNTER_A, voiceChannel(COUNTER_A, legacyName('  Members: {count}  ', 42)));

    expect(plan(counters, state, new Map(), NOW).edits).toEqual([
      { channelId: COUNTER_A, from: '  Members: 42  ', to: 'Members: 42' },
    ]);

    state.channels.set(COUNTER_A, voiceChannel(COUNTER_A, 'Members: 42'));
    const second = plan(counters, state, new Map(), NOW);

    expect(second.edits).toEqual([]);
    expect(second.unchanged).toEqual([COUNTER_A]);
  });
});

describe('counts beyond the counter’s own', () => {
  function mixedState(): GuildState {
    const state = guildState();
    const kinds: Array<[string, number | undefined]> = [
      ['700000000000000001', 5],
      ['700000000000000002', 13],
      ['700000000000000003', 15],
      ['700000000000000004', 4],
      ['700000000000000005', 11],
      ['700000000000000006', undefined],
    ];

    for (const [id, type] of kinds) {
      const channel: ChannelState = {
        id,
        parentId: null,
        name: `channel ${id}`,
        overwrites: [],
        ...(type === undefined ? {} : { type }),
      };
      state.channels.set(id, channel);
    }

    return state;
  }

  test('{count.roles} on a members counter renders the role count', () => {
    const state = guildState();

    expect(countFor('roles', state)).toBe(2);
    expect(renderName('Roles: {count.roles}', 'members', state, NOW)).toBe('Roles: 2');
  });

  test('channels are counted by kind, leaving out categories and threads', () => {
    const state = mixedState();

    expect(countFor('channels', state)).toBe(7);
    expect(
      renderName(
        '{count.channels} all, {count.text_channels} text, {count.voice_channels} voice',
        'roles',
        state,
        NOW,
      ),
    ).toBe('7 all, 2 text, 3 voice');
  });

  test('members, the server name and boosts', () => {
    const state: GuildState = { ...guildState(), name: 'Proton HQ', boostCount: 14, boostTier: 2 };

    expect(
      renderName(
        '{server.name} {count.members} {server.boost_count} {server.boost_tier}',
        'roles',
        state,
        NOW,
      ),
    ).toBe(`Proton HQ ${MEMBER_COUNT} 14 2`);
  });

  test('modifiers format the number', () => {
    expect(renderName('Members: {count:number}', 'members', withMembers(1204), NOW)).toBe(
      'Members: 1,204',
    );
    expect(renderName('{counter.count:compact} members', 'members', withMembers(1204), NOW)).toBe(
      '1.2K members',
    );
  });

  test('an uncached member count renders its fallback, and says why', () => {
    const rendered = renderCounterName(
      'Roles {count} of {count.members:fallback("?")}',
      { source: 'roles', state: withoutMembers() },
      NOW,
    );

    expect(rendered.output).toBe('Roles 2 of ?');
    expect(rendered.diagnostics.find(({ code }) => code === 'unavailable')?.message).toContain(
      'no member count cached',
    );
  });

  test('a members counter still skips when members are unknown, whatever its template reads', () => {
    expect(
      plan(config([pointed('Roles: {count.roles}')]), withoutMembers(), new Map(), NOW),
    ).toEqual({ creations: [], edits: [], unchanged: [], unavailable: [COUNTER_A], blank: [] });
  });
});

describe('a name that comes out empty', () => {
  test('is not renamed, and the plan says which placeholder left it empty', () => {
    const state: GuildState = { ...guildState(), boostCount: null };
    const result = plan(config([pointed('{server.boost_count}')]), state, new Map(), NOW);

    expect(result.edits).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.unavailable).toEqual([]);
    expect(result.blank).toHaveLength(1);
    expect(result.blank[0]).toMatchObject({
      counterId: COUNTER_A,
      channelId: COUNTER_A,
      template: '{server.boost_count}',
    });
    expect(result.blank[0]?.humanReason).toContain('1 to 100 characters');
    expect(result.blank[0]?.humanReason).toContain('{server.boost_count} has no value');
  });

  test('a counter Proton would make the channel for is not made', () => {
    const state: GuildState = { ...guildState(), boostCount: null };
    const result = plan(
      config([{ id: 'boosts', template: '{server.boost_count}', source: 'members' }]),
      state,
      new Map(),
      NOW,
    );

    expect(result.creations).toEqual([]);
    expect(result.blank[0]).toMatchObject({ counterId: 'boosts', channelId: null });
  });

  test('/counters refresh names the channel and the reason instead of renaming it', async () => {
    const h = harness();
    h.state.boostCount = null;

    await h.run(subcommand('refresh'), { config: { counters: [pointed('{server.boost_count}')] } });

    expect(h.patches()).toHaveLength(0);

    const reply = h.replyContent() ?? '';
    expect(reply).toContain('1 refused');
    expect(reply).toContain(`<#${COUNTER_A}> was not renamed`);
    expect(reply).toContain('{server.boost_count} has no value');
    expect(h.logs.some((line) => line.level === 'error' && line.message.includes(COUNTER_A))).toBe(
      true,
    );
  });

  test('/counters refresh makes no channel for one and names its template', async () => {
    const h = harness();
    h.state.boostCount = null;

    await h.run(subcommand('refresh'), {
      config: { counters: [{ id: 'boosts', template: '{server.boost_count}', source: 'members' }] },
    });

    expect(h.creates()).toHaveLength(0);
    expect(h.owned.rows.size).toBe(0);
    expect(h.replyContent()).toContain('could not make the channel for “{server.boost_count}”');
  });
});

describe('the name template refine', () => {
  const parse = (template: string) =>
    countersConfigSchema.safeParse({ counters: [{ id: 'c1', template, source: 'members' }] });

  test('accepts a template that uses only canonical counts', () => {
    for (const template of [
      'Roles: {count.roles}',
      '{count.text_channels} text',
      '{count.voice_channels:number} voice',
      'Boosts {server.boost_count}',
      'Members {counter.count:number}',
    ]) {
      expect(parse(template).success).toBe(true);
    }
  });

  test('still accepts a stored {{count}}, which now renders as the literal text', () => {
    expect(parse('Members: {{count}}').success).toBe(true);
    expect(legacyName('Members: {{count}}', 42)).toBe('Members: {42}');
    expect(renderName('Members: {{count}}', 'members', withMembers(42), NOW)).toBe(
      'Members: {count}',
    );
  });

  test('refuses a template with no count in it, and names one to use', () => {
    for (const template of [
      'Members',
      '{server.name}',
      '{server.boost_tier}',
      '{count.nope}',
      '{{count.roles}}',
      '{now}',
      '{members}',
    ]) {
      const result = parse(template);

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('{count}');
      expect(result.error?.issues[0]?.message).toContain('{count.roles}');
    }
  });

  test('the count keys are every count, the counter’s own and the boost count', () => {
    expect([...COUNT_KEYS]).toEqual([
      'counter.count',
      'count.members',
      'count.roles',
      'count.channels',
      'count.text_channels',
      'count.voice_channels',
      'server.boost_count',
    ]);
  });
});

describe('validation on save', () => {
  test('{now}, {today} and {year} are refused, naming the field', () => {
    for (const clock of ['now', 'today', 'year']) {
      const report = validateConfigTemplates(
        countersTemplates,
        config([pointed(`{count} at {${clock}}`)]),
        config([pointed('{count}')]),
      );

      expect(
        report.blocking.map(({ path, label, diagnostic }) => [path, label, diagnostic.code]),
      ).toEqual([['counters.0.template', 'Name template', 'unavailable']]);
      expect(formatTemplateIssues(report)).toStartWith(
        `counters.0.template Name template: {${clock}} is not available for ${COUNTER_EVENT}`,
      );
    }
  });

  test('an unchanged stored clock does not stop the module being switched on', () => {
    const stored = { ...config([pointed('{count} at {now}')]), enabled: false };
    const report = validateConfigTemplates(countersTemplates, { ...stored, enabled: true }, stored);

    expect(report.blocking).toEqual([]);
    expect(codes(report.byPath.get('counters.0.template') ?? [])).toContain('unavailable');
  });

  test('a misspelt count warns with a suggestion and never blocks', () => {
    const report = validateConfigTemplates(
      countersTemplates,
      config([pointed('{count} {count.membrs}')]),
      config([]),
    );
    const diagnostics = report.byPath.get('counters.0.template') ?? [];

    expect(report.blocking).toEqual([]);
    expect(diagnostics.find(({ code }) => code === 'unknown_placeholder')?.message).toContain(
      'Did you mean {count.members}?',
    );
    expect(codes(diagnostics)).toContain('legacy_alias');
  });

  test('a name that renders empty is not refused at save, where no count is read', () => {
    const report = validateConfigTemplates(
      countersTemplates,
      config([pointed('{server.boost_count}')]),
      config([]),
    );

    expect(report.blocking).toEqual([]);
  });

  test('the picker offers the counts and the server, never a clock', () => {
    expect(COUNTER_SURFACE.pickerFor('counters.3.template').map(({ key }) => key)).toEqual([
      'counter.count',
      'count.members',
      'count.roles',
      'count.channels',
      'count.text_channels',
      'count.voice_channels',
      'server.name',
      'server.boost_count',
      'server.boost_tier',
    ]);
    expect(COUNTER_SURFACE.pickerFor('counters.template')).toEqual([]);
  });

  test('the lookup is never asked for a clock', () => {
    const asked: string[] = [];
    const inner = COUNTER_SURFACE.build(sample().facts, { now: NOW });

    const rendered = renderTemplate(
      '{now}{today}{year} {count}',
      (request: PlaceholderRequest) => {
        asked.push(request.canonical);
        return inner(request);
      },
      {
        registry: COUNTER_SURFACE.registry,
        field: 'channel_name',
        channel: 'voice',
        event: COUNTER_EVENT,
        audience: 'public',
        now: NOW,
      },
    );

    expect(rendered.output).toBe('1204');
    expect(asked).toEqual(['counter.count']);
  });
});

describe('restricted data', () => {
  test('a channel name is seen by anyone, so every placeholder offered is public', () => {
    expect(COUNTER_SURFACE.audience).toBe('public');

    for (const definition of COUNTER_SURFACE.definitions) {
      expect(definition.sensitivity).toBe('public');
      expect(isRestricted(definition, 'public')).toBe(false);
    }
  });

  test('no member, Proton or event data is offered at all', () => {
    const keys = COUNTER_SURFACE.definitions.map(({ key }) => key);

    expect(
      keys.filter((key) => /^(user|actor|moderator|target|bot|event|channel)\./.test(key)),
    ).toEqual([]);
    expect(keys.filter((key) => key.startsWith('server.'))).toEqual([
      'server.name',
      'server.boost_count',
      'server.boost_tier',
    ]);
  });
});

describe('prototype names and injected values', () => {
  test('reserved names are posted as written and never resolve', () => {
    const template =
      '{constructor} {__proto__} {prototype} {count.constructor} {counter.__proto__} {toString} {count}';
    const rendered = renderCounterName(template, { source: 'members', state: withMembers(5) }, NOW);

    expect(rendered.output).toBe(
      '{constructor} {__proto__} {prototype} {count.constructor} {counter.__proto__} {toString} 5',
    );
    expect(codes(rendered.diagnostics)).toContain('forbidden_key');
    expect(() =>
      validateConfigTemplates(countersTemplates, config([pointed(template)])),
    ).not.toThrow();
  });

  test('a config parsed from hostile JSON is read by its own keys only', () => {
    const hostile: unknown = JSON.parse(
      '{"counters":[{"template":"{count} {now}","__proto__":{"template":"{year}"}}],' +
        '"__proto__":{"counters":[{"template":"{today}"}]}}',
    );

    expect(countersTemplates.collect(hostile).map(({ path, text }) => [path, text])).toEqual([
      ['counters.0.template', '{count} {now}'],
    ]);
    expect(Object.hasOwn(Object.prototype, 'counters')).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'template')).toBe(false);
  });

  test('a server name is written as it is, never expanded and never read as markup', () => {
    const state: GuildState = {
      ...guildState(),
      name: '{count} <@&1> @everyone\n**x**​',
    };

    expect(renderName('{server.name} {count}', 'members', state, NOW)).toBe(
      `{count} <@&1> @everyone **x** ${MEMBER_COUNT}`,
    );
  });
});

describe('limits', () => {
  test('a long server name is cut to the channel-name cap', () => {
    const state: GuildState = { ...guildState(), name: 'P'.repeat(300) };

    expect(renderName('{server.name}: {count}', 'members', state, NOW)).toBe('P'.repeat(100));
  });

  test('an emoji-heavy name never passes the cap and never ends in half a character', () => {
    const state: GuildState = { ...guildState(), name: FAMILY.repeat(40) };

    for (let pad = 0; pad < 8; pad += 1) {
      const name = renderName(`${'a'.repeat(pad)}{server.name}`, 'members', state, NOW);

      expect(name.length).toBeLessThanOrEqual(CHANNEL_NAME_MAX);
      expect(name.length).toBeGreaterThan(CHANNEL_NAME_MAX - 8);
      expect(LONE_SURROGATE.test(name)).toBe(false);
    }
  });

  test('a template at its own maximum fits with the largest number in it', () => {
    const template = `${'x'.repeat(TEMPLATE_MAX - '{count}'.length)}{count}`;

    expect(
      renderName(template, 'members', withMembers(Number.MAX_SAFE_INTEGER), NOW).length,
    ).toBeLessThanOrEqual(CHANNEL_NAME_MAX);
  });

  test('the field declares Discord’s channel-name cap', () => {
    expect(COUNTER_SURFACE.fieldAt('counters.0.template')?.limit).toBe(CHANNEL_NAME_MAX);
  });
});

describe('the counters surface', () => {
  test('is a public voice channel name written by the refresh', () => {
    expect(COUNTER_SURFACE.id).toBe('counters.channel_name');
    expect(COUNTER_SURFACE.module).toBe('counters');
    expect(COUNTER_SURFACE.event).toBe('counters.refresh');
    expect(COUNTER_SURFACE.fields).toEqual([
      {
        path: 'counters.*.template',
        kind: 'channel_name',
        channel: 'voice',
        label: 'Name template',
        limit: CHANNEL_NAME_MAX,
      },
    ]);
    expect(COUNTER_SURFACE.pings).toEqual({});
  });

  test('the only older name is {count}', () => {
    expect(
      COUNTER_SURFACE.definitions
        .filter(({ aliases }) => aliases.length > 0)
        .map(({ key, aliases }) => [key, aliases]),
    ).toEqual([['counter.count', ['count']]]);
  });

  test('the manifest carries the templates', () => {
    expect(createCountersModule().templates).toBe(countersTemplates);
    expect(Object.keys(countersTemplates.surfaces)).toEqual(['counters.channel_name']);
    expect(countersTemplates.surfaces['counters.channel_name']).toBe(COUNTER_SURFACE);
  });

  test('collects every counter template and never throws on garbage', () => {
    const sites = countersTemplates.collect(
      config([
        pointed('Members: {count}'),
        { id: 'r', template: 'Roles: {count}', source: 'roles' },
      ]),
    );

    expect(sites.map(({ path, surfaceId, text }) => [path, surfaceId, text])).toEqual([
      ['counters.0.template', 'counters.channel_name', 'Members: {count}'],
      ['counters.1.template', 'counters.channel_name', 'Roles: {count}'],
    ]);

    for (const garbage of [
      null,
      undefined,
      'counters',
      1,
      [],
      {},
      { counters: 'x' },
      { counters: [null, 3, { template: 3 }, []] },
    ]) {
      expect(countersTemplates.collect(garbage)).toEqual([]);
    }
  });

  test('its sample is the shared sample server, counted', () => {
    const { id, label, facts } = sample();

    expect(id).toBe('member');
    expect(label).toBe('Sample count: 1,204');
    expect(facts.source).toBe('members');
    expect(serverFactsFrom(facts.state, facts.state.guildId)).toEqual(SAMPLE_SERVER);
    expect(renderCounterName('Members: {count:number}', facts, SAMPLE_NOW).output).toBe(
      'Members: 1,204',
    );
    expect(
      renderCounterName(
        '{count.channels} = {count.text_channels} text + {count.voice_channels} voice',
        facts,
        SAMPLE_NOW,
      ).output,
    ).toBe('40 = 28 text + 12 voice');
  });
});
