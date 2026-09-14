import { describe, expect, test } from 'bun:test';
import {
  createPlaceholderRegistry,
  lookupFrom,
  normaliseChannelName,
  PLACEHOLDER_LIMITS,
  type PlaceholderRequest,
  parseTemplate,
  type ResolvedValue,
  renderTemplate,
  resolvedValueSchema,
  placeholderValue as v,
} from '../../src/placeholders/index.ts';
import { AT, codes, define, MEMBER, ROLE, registry, render } from './harness.ts';

describe('absent states', () => {
  test('an unknown key is posted as written and listed', () => {
    const rendered = render('Hi {member.nickname} {user}', { 'member.mention': v.user(MEMBER) });

    expect(rendered.output).toBe(`Hi {member.nickname} <@${MEMBER}>`);
    expect(rendered.unknown).toEqual(['member.nickname']);
    expect(codes(rendered)).toEqual(['unknown_placeholder']);
  });

  test('a lookup that calls a key unknown leaves it as written too', () => {
    const rendered = render('{answer.reason}', { 'answer.reason': v.unknownKey() });

    expect(rendered.output).toBe('{answer.reason}');
    expect(rendered.unknown).toEqual(['answer.reason']);
  });

  test('every other absent state renders as nothing, each with its own diagnostic', () => {
    const cases: Array<[ResolvedValue, string]> = [
      [v.unavailable(), 'unavailable'],
      [v.notSet(), 'not_set'],
      [v.restricted(), 'restricted'],
      [v.failed('Discord timed out'), 'resolver_failed'],
    ];

    for (const [value, code] of cases) {
      const rendered = render('[{member.display_name}]', { 'member.display_name': value });

      expect(rendered.output).toBe('[]');
      expect(codes(rendered)).toEqual([code]);
    }

    expect(
      render('{member.display_name}', { 'member.display_name': v.failed('Discord timed out') })
        .diagnostics[0]?.message,
    ).toContain('Discord timed out');
  });

  test('a key the snapshot never supplied is unavailable', () => {
    const rendered = render('[{server.name}]');

    expect(rendered.output).toBe('[]');
    expect(codes(rendered)).toEqual(['unavailable']);
  });

  test('a lookup that throws costs only its own placeholders', () => {
    const rendered = renderTemplate(
      'a{server.name}b{user}c',
      () => {
        throw new Error('boom');
      },
      { registry, field: 'discord_text' },
    );

    expect(rendered.output).toBe('abc');
    expect(codes(rendered)).toEqual(['resolver_failed', 'resolver_failed']);
    expect(rendered.diagnostics[0]?.message).toContain('boom');
  });

  test('a value that is not a placeholder value fails instead of being written', () => {
    for (const raw of [
      '{"type":"integer","value":1.5}',
      '{"type":"text"}',
      'null',
      '"Ada"',
      '{"type":"mention","value":"@everyone"}',
      '{"type":"url","value":"javascript:alert(1)"}',
      '{"type":"number","value":null}',
      '{"type":"list","of":"text","items":[{"type":"integer","value":1}]}',
    ]) {
      const rendered = renderTemplate('[{member.display_name}]', () => JSON.parse(raw), {
        registry,
        field: 'discord_text',
      });

      expect(rendered.output).toBe('[]');
      expect(codes(rendered)).toEqual(['invalid_value']);
    }
  });

  test('a value of the wrong type fails rather than rendering as something else', () => {
    const rendered = render('[{server.member_count}]', { 'server.member_count': v.text('42') });

    expect(rendered.output).toBe('[]');
    expect(codes(rendered)).toEqual(['invalid_value']);
    expect(rendered.diagnostics[0]?.message).toContain('a whole number');
  });

  test('a placeholder that is unavailable or restricted is never looked up', () => {
    let asked = 0;
    const rendered = renderTemplate(
      '{boost.tier}{case.note}{card.caption}',
      (): ResolvedValue => {
        asked += 1;
        return v.integer(2);
      },
      { registry, field: 'discord_text' },
    );

    expect(rendered.output).toBe('');
    expect(asked).toBe(0);
    expect(codes(rendered)).toEqual(['unavailable', 'restricted', 'unavailable']);
  });

  test('a restricted placeholder renders for an audience allowed to see it', () => {
    expect(
      render('{case.note}', { 'case.note': v.text('watch') }, { audience: 'staff_only' }).output,
    ).toBe('watch');
  });

  test('an event-limited placeholder renders in its event', () => {
    expect(
      render('{boost.tier}', { 'boost.tier': v.integer(2) }, { event: 'member.boosted' }).output,
    ).toBe('2');
  });
});

describe('zero, false and empty are values', () => {
  const cases: Array<[string, ResolvedValue, string]> = [
    ['server.member_count', v.integer(0), '0'],
    ['server.member_count', v.integer(-0), '0'],
    ['stats.average', v.number(0), '0'],
    ['poll.share', v.percent(0), '0%'],
    ['member.boosting', v.boolean(false), 'No'],
    ['giveaway.duration', v.duration(0), '0s'],
    ['member.display_name', v.text(''), ''],
    ['member.roles', v.list('mention', []), ''],
  ];

  for (const [key, value, output] of cases) {
    test(`${key} = ${JSON.stringify(value)}`, () => {
      const rendered = render(`[{${key}}]`, { [key]: value });

      expect(rendered.output).toBe(`[${output}]`);
      expect(rendered.diagnostics).toEqual([]);
    });
  }
});

describe('rendering is one pass', () => {
  const values = {
    'member.display_name': v.text('{user.mention} {{server}} {server} {member.mention}'),
    'member.mention': v.user(MEMBER),
    'server.name': v.text('Proton'),
  };

  test('a substituted value is never scanned for placeholders or escapes', () => {
    const written = '{user.mention} {{server}} {server} {member.mention}';

    expect(render('{member.display_name}', values, { field: 'plain_text' }).output).toBe(written);
    expect(render('{member.display_name}', values).output).toBe(written);
    expect(
      render('{member.display_name}', values, { field: 'channel_name', channel: 'voice' }).output,
    ).toBe(written);
  });

  test('nor is a mention’s name or a label', () => {
    expect(
      render(
        '{member.mention}',
        { 'member.mention': v.user(MEMBER, '{server}') },
        { field: 'plain_text' },
      ).output,
    ).toBe('{server}');
    expect(
      render('{member.boosting:label("{user}","no")}', { 'member.boosting': v.boolean(true) })
        .output,
    ).toBe('{user}');
  });
});

describe('Discord text', () => {
  test('escapes markdown in text, and keeps trusted markdown and mentions as markup', () => {
    const rendered = render('{member.display_name} {rules.body} {member.mention}', {
      'member.display_name': v.text('**bold** _x_ ~s~ `c` |sp| <@1> [a](b) https://x.test'),
      'rules.body': v.markdown('**Be kind**'),
      'member.mention': v.user(MEMBER, 'Ada'),
    });

    expect(rendered.output).toBe(
      '\\*\\*bold\\*\\* \\_x\\_ \\~s\\~ \\`c\\` \\|sp\\| \\<@1\\> \\[a\\](b) https\\://x.test ' +
        `**Be kind** <@${MEMBER}>`,
    );
  });

  test('escapes markdown that only means something at the start of a line', () => {
    const escaped = (value: string): string =>
      render('{member.display_name}', { 'member.display_name': v.text(value) }).output;

    expect(escaped('# big')).toBe('\\# big');
    expect(escaped('-# small')).toBe('\\-# small');
    expect(escaped('> quote')).toBe('\\> quote');
    expect(escaped('1. item')).toBe('1\\. item');
    expect(escaped('a\n  - b')).toBe('a\n  \\- b');
    expect(escaped('a-b #1')).toBe('a-b #1');
  });

  test('the template’s own text is never escaped', () => {
    expect(render('**Welcome** _{server.name}_', { 'server.name': v.text('Proton') }).output).toBe(
      '**Welcome** _Proton_',
    );
  });
});

describe('plain text', () => {
  test('escapes nothing and writes a mention as its readable name', () => {
    const rendered = render(
      '{member.display_name} {member.mention}',
      { 'member.display_name': v.text('**b**'), 'member.mention': v.user(MEMBER, 'Ada') },
      { field: 'plain_text' },
    );

    expect(rendered.output).toBe('**b** Ada');
  });

  test('a mention with no name renders as nothing, and says so', () => {
    const rendered = render(
      '[{member.mention}]',
      { 'member.mention': v.user(MEMBER) },
      { field: 'plain_text' },
    );

    expect(rendered.output).toBe('[]');
    expect(codes(rendered)).toEqual(['mention_without_name']);
  });
});

describe('channel names', () => {
  const name = (value: string, template = '{member.display_name}') =>
    render(
      template,
      { 'member.display_name': v.text(value), 'member.mention': v.user(MEMBER, 'Ada') },
      { field: 'channel_name' },
    );

  test('a text channel name is lowercase, dashed and stripped of what Discord refuses', () => {
    expect(name('Ada Lovelace', '{member.display_name}’s Room!!').output).toBe(
      'ada-lovelace’s-room',
    );
    expect(name('a​bc').output).toBe('abc');
    expect(name(' -- Hello -- ').output).toBe('hello');
    expect(name('x'.repeat(150)).output).toBe('x'.repeat(100));
    expect(name('', '{member.mention}-chat').output).toBe('ada-chat');
  });

  test('a voice channel name keeps its case and spaces', () => {
    const voice = (value: string): string =>
      render(
        '{member.display_name}',
        { 'member.display_name': v.text(value) },
        { field: 'channel_name', channel: 'voice' },
      ).output;

    expect(voice('  Ada   Room  ')).toBe('Ada   Room');
    expect(voice('Line\nbreak')).toBe('Line break');
    expect(voice('Ada’s Room!')).toBe('Ada’s Room!');
  });

  test('a voice channel name cut at 100 characters never ends in a space', () => {
    const voice = (value: string) =>
      render(
        '{member.display_name}',
        { 'member.display_name': v.text(value) },
        { field: 'channel_name', channel: 'voice' },
      );

    const cut = voice(`${'a'.repeat(99)} bcd`);
    expect(cut.output).toBe('a'.repeat(99));
    expect(cut.diagnostics).toEqual([]);
    expect(normaliseChannelName(`${'a'.repeat(98)}  b`, 'voice')).toBe('a'.repeat(98));

    const blank = voice(' \n\t ');
    expect(blank.output).toBe('');
    expect(codes(blank)).toEqual(['empty_channel_name']);
  });

  test('a voice channel name keeps what holds an emoji together, and still drops other invisibles', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const flag = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    const heart = '❤️';
    const voice = (value: string): string =>
      render(
        '{member.display_name}',
        { 'member.display_name': v.text(value) },
        { field: 'channel_name', channel: 'voice' },
      ).output;

    expect(voice(`${family} Members`)).toBe(`${family} Members`);
    expect(voice(`${flag} ${heart} a‌b`)).toBe(`${flag} ${heart} a‌b`);
    expect(voice('a​b‎cd\u{E0001}e')).toBe('abcde');
    expect(normaliseChannelName(`a${family}b`, 'text')).toBe('a\u{1F468}\u{1F469}\u{1F467}b');

    const counters = createPlaceholderRegistry([
      define('counter.count', 'integer', v.integer(1), { aliases: ['count'] }),
    ]);
    const template = `${family} Members: {count}`;

    expect(
      renderTemplate(template, lookupFrom({ 'counter.count': v.integer(42) }), {
        registry: counters,
        field: 'channel_name',
        channel: 'voice',
      }).output,
    ).toBe(template.split('{count}').join('42').slice(0, 100));
  });

  test('a name that renders empty is reported', () => {
    const rendered = name('!!!');

    expect(rendered.output).toBe('');
    expect(codes(rendered)).toEqual(['empty_channel_name']);
  });
});

describe('links', () => {
  const link = (template: string, values: Record<string, ResolvedValue> = {}) =>
    render(template, values, { field: 'url' });

  test('keeps an http or https link', () => {
    expect(link('{appeal.link}', { 'appeal.link': v.url('https://prtn.xyz/appeal') }).output).toBe(
      'https://prtn.xyz/appeal',
    );
    expect(link('  https://prtn.xyz  ').output).toBe('https://prtn.xyz');
  });

  test('encodes text written into a link, so it cannot change the link’s shape', () => {
    expect(
      link('https://prtn.xyz/u/{member.display_name}?id={member.id}', {
        'member.display_name': v.text('a b/c?d'),
        'member.id': v.text(MEMBER),
      }).output,
    ).toBe(`https://prtn.xyz/u/a%20b%2Fc%3Fd?id=${MEMBER}`);
  });

  test('anything that is not an http or https link renders as nothing', () => {
    for (const [template, values] of [
      ['javascript:alert(1)', {}],
      ['ftp://prtn.xyz/file', {}],
      ['{member.display_name}', { 'member.display_name': v.text('javascript:alert(1)') }],
    ] as const) {
      const rendered = link(template, values);

      expect(rendered.output).toBe('');
      expect(codes(rendered)).toEqual(['invalid_url']);
    }
  });

  test('an absent link is simply empty', () => {
    const rendered = link('{appeal.link}', { 'appeal.link': v.notSet() });

    expect(rendered.output).toBe('');
    expect(codes(rendered)).toEqual(['not_set']);
  });

  test('a mention cannot go in a link', () => {
    const rendered = link('{member.mention}', { 'member.mention': v.user(MEMBER) });

    expect(rendered.output).toBe('');
    expect(codes(rendered)).toEqual(['incompatible_field']);
  });
});

describe('mass mentions', () => {
  const MASS = /@(everyone|here)/i;

  test('a text value cannot post @everyone or @here in Discord text', () => {
    const rendered = render('Hi {member.display_name}', {
      'member.display_name': v.text('@everyone @here'),
    });

    expect(rendered.output).toBe('Hi @​everyone @​here');
    expect(rendered.output).not.toMatch(MASS);
    expect(rendered.diagnostics).toEqual([]);
  });

  test('nor can an alias, trusted markdown or a list item', () => {
    expect(render('{username}', { 'member.display_name': v.text('@Here') }).output).toBe('@​Here');
    expect(render('{rules.body}', { 'rules.body': v.markdown('**@everyone**') }).output).toBe(
      '**@​everyone**',
    );
    expect(
      render('{giveaway.winners}', {
        'giveaway.winners': v.list('text', [v.text('a'), v.text('@everyone')]),
      }).output,
    ).toBe('a, @​everyone');
  });

  test('nor can a value finish one that the template or another value starts', () => {
    const values = {
      'member.display_name': v.text('everyone'),
      'member.id': v.text('@ever'),
      'server.name': v.text('yone'),
    };

    expect(render('@{member.display_name}', values).output).toBe('@​everyone');
    expect(render('{member.id}yone', values).output).toBe('@​everyone');
    expect(render('{member.id}{server.name}', values).output).toBe('@​everyone');
    expect(
      render('{giveaway.winners:join("@")}', {
        'giveaway.winners': v.list('text', [v.text('a'), v.text('here')]),
      }).output,
    ).toBe('a@​here');
  });

  test('the template’s own @everyone, fallback and label are left alone', () => {
    expect(render('@everyone {server.name}', { 'server.name': v.text('x') }).output).toBe(
      '@everyone x',
    );
    expect(
      render('@{member.display_name:fallback("here")}', { 'member.display_name': v.notSet() })
        .output,
    ).toBe('@here');
    expect(
      render('{member.boosting:label("@everyone","")}', { 'member.boosting': v.boolean(true) })
        .output,
    ).toBe('@everyone');
  });

  test('outside Discord text nothing is changed', () => {
    expect(
      render(
        '@{member.display_name}',
        { 'member.display_name': v.text('here @everyone') },
        { field: 'plain_text' },
      ).output,
    ).toBe('@here @everyone');
  });
});

describe('link values', () => {
  test('a link value must parse as an http or https address with nothing Discord reads as markup', () => {
    for (const raw of [`https://x.co/<@&${ROLE}>`, 'https://x.co/"q"', 'https://[bad']) {
      expect(resolvedValueSchema.safeParse(v.url(raw)).success).toBe(false);

      const inText = render('[{appeal.link}][{server.icon_url}]', {
        'appeal.link': v.url(raw),
        'server.icon_url': v.imageUrl(raw),
      });
      expect(inText.output).toBe('[][]');
      expect(codes(inText)).toEqual(['invalid_value', 'invalid_value']);

      const inLink = render('{appeal.link}', { 'appeal.link': v.url(raw) }, { field: 'url' });
      expect(inLink.output).toBe('');
      expect(codes(inLink)).toEqual(['invalid_value']);
    }
  });

  test('a link in Discord text cannot carry a mass mention, and still works as a link', () => {
    const values = {
      'appeal.link': v.url('https://x.co/@everyone?to=@here'),
      'server.icon_url': v.imageUrl('https://x.co/@Here.png'),
    };
    const rendered = render('{appeal.link} {server.icon_url}', values);

    expect(rendered.output).toBe('https://x.co/%40everyone?to=%40here https://x.co/%40Here.png');
    expect(rendered.output).not.toMatch(/@(everyone|here)/i);
    expect(render('{appeal.link}', values, { field: 'url' }).output).toBe(
      'https://x.co/@everyone?to=@here',
    );
  });

  test('an alias written into a link is encoded exactly like its canonical key', () => {
    const answers = createPlaceholderRegistry([
      define('answer.value', 'text', v.text('x'), { aliases: ['answer'] }),
    ]);
    const link = (template: string, value: string) =>
      renderTemplate(template, lookupFrom({ 'answer.value': v.text(value) }), {
        registry: answers,
        field: 'url',
      });

    for (const template of ['https://prtn.xyz/?q={answer}', 'https://prtn.xyz/?q={answer.value}']) {
      expect(link(template, 'a&admin=1#frag').output).toBe(
        'https://prtn.xyz/?q=a%26admin%3D1%23frag',
      );
    }

    const phish = link('{answer}', 'https://evil.example/phish');
    expect(phish.output).toBe('');
    expect(codes(phish)).toEqual(['invalid_url']);
  });
});

describe('dynamic segments', () => {
  test('the lookup is told which segment matched', () => {
    const requests: PlaceholderRequest[] = [];
    const rendered = renderTemplate(
      '{answer.reason} / {option.red-team.votes}',
      (request) => {
        requests.push(request);
        return request.definition.type === 'integer' ? v.integer(3) : v.text('hacked');
      },
      { registry, field: 'plain_text' },
    );

    expect(rendered.output).toBe('hacked / 3');
    expect(requests.map((request) => [request.canonical, request.params])).toEqual([
      ['answer.reason', { question_key: 'reason' }],
      ['option.red-team.votes', { key: 'red-team' }],
    ]);
  });
});

describe('bounds and inputs', () => {
  test('output is cut at its limit, before the destination’s own rules', () => {
    const rendered = render(
      '{member.display_name}{member.display_name}',
      { 'member.display_name': v.text('x'.repeat(4000)) },
      { field: 'plain_text' },
    );

    expect(rendered.output).toHaveLength(6000);
    expect(codes(rendered)).toEqual(['output_truncated']);
  });

  test('an oversized value is bounded before it is rendered', () => {
    const rendered = render(
      '{member.display_name}',
      { 'member.display_name': v.text('x'.repeat(100_000)) },
      { field: 'plain_text' },
    );

    expect(rendered.output).toHaveLength(6000);
  });

  test('a list writes at most fifty items but counts every one', () => {
    const winners = {
      'giveaway.winners': v.list(
        'text',
        Array.from({ length: 60 }, (_, index) => v.text(`w${index}`)),
      ),
    };

    const written = render('{giveaway.winners}', winners, { field: 'plain_text' });
    expect(written.output.split(', ')).toHaveLength(50);
    expect(codes(written)).toEqual(['list_truncated']);

    const counted = render('{giveaway.winners:count}', winners);
    expect(counted.output).toBe('60');
    expect(codes(counted)).toEqual([]);
  });

  test('every item of a list is checked, not only the ones written, and a list is bounded', () => {
    const items = (length: number): unknown[] =>
      Array.from({ length }, (_, index) => ({ type: 'text', value: `w${index}` }));
    const count = (list: unknown[]) =>
      renderTemplate(
        '[{giveaway.winners:count}]',
        () => JSON.parse(JSON.stringify({ type: 'list', of: 'text', items: list })),
        { registry, field: 'discord_text' },
      );

    const broken = items(60);
    broken[54] = { type: 'integer', value: 1 };
    const invalid = count(broken);
    expect(invalid.output).toBe('[]');
    expect(codes(invalid)).toEqual(['invalid_value']);
    expect(invalid.diagnostics[0]?.message).toContain('item 55');

    const max = PLACEHOLDER_LIMITS.listLength;
    const full = count(items(max));
    expect(full.output).toBe(`[${max}]`);
    expect(full.diagnostics).toEqual([]);

    const over = count(items(max + 1));
    expect(over.output).toBe('[]');
    expect(codes(over)).toEqual(['invalid_value']);
    expect(over.diagnostics[0]?.message).toContain(`${max}`);
  });

  test('a parsed template renders again with other values', () => {
    const parsed = parseTemplate('Hi {server}', registry);
    const once = renderTemplate(parsed, lookupFrom({ 'server.name': v.text('A') }), {
      registry,
      field: 'plain_text',
    });
    const twice = renderTemplate(parsed, lookupFrom(new Map([['server.name', v.text('B')]])), {
      registry,
      field: 'plain_text',
    });

    expect([once.output, twice.output]).toEqual(['Hi A', 'Hi B']);
  });

  test('an unknown locale or time zone falls back, and says so', () => {
    const rendered = render(
      '{member.joined_at:date}',
      { 'member.joined_at': v.datetime(AT) },
      { field: 'plain_text', locale: 'not a locale!!', timeZone: 'Mars/Olympus' },
    );

    expect(rendered.output).toBe('Nov 14, 2023');
    expect(codes(rendered)).toEqual(['invalid_locale', 'invalid_time_zone']);
  });
});
