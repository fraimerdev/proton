import { describe, expect, test } from 'bun:test';
import {
  createPlaceholderRegistry,
  lookupFrom,
  modifiersFor,
  type ResolvedValue,
  renderTemplate,
  placeholderValue as v,
} from '../../src/placeholders/index.ts';
import { AT, codes, define, MEMBER, ROLE, render } from './harness.ts';

const HOUR = 3_600_000;
const UNIX = AT / 1000;
const PLAIN = { field: 'plain_text', timeZone: 'UTC' } as const;

describe('number modifiers', () => {
  test(':number groups digits for the locale', () => {
    const count = { 'server.member_count': v.integer(1_234_567) };

    expect(render('{server.member_count:number}', count).output).toBe('1,234,567');
    expect(render('{server.member_count:number}', count, { locale: 'de-DE' }).output).toBe(
      '1.234.567',
    );
    expect(render('{stats.average:number}', { 'stats.average': v.number(1234.5678) }).output).toBe(
      '1,234.57',
    );
  });

  test('without :number an integer is written plainly, as it always was', () => {
    expect(
      render('{server.member_count}', { 'server.member_count': v.integer(1_234_567) }).output,
    ).toBe('1234567');
  });

  test(':compact shortens large numbers', () => {
    const compact = (value: number): string =>
      render('{server.member_count:compact}', { 'server.member_count': v.integer(value) }).output;

    expect(compact(1234)).toBe('1.2K');
    expect(compact(999)).toBe('999');
    expect(compact(1_500_000)).toBe('1.5M');
  });

  test(':ordinal', () => {
    const cases: Array<[number, string]> = [
      [0, '0th'],
      [1, '1st'],
      [2, '2nd'],
      [3, '3rd'],
      [4, '4th'],
      [11, '11th'],
      [12, '12th'],
      [13, '13th'],
      [21, '21st'],
      [22, '22nd'],
      [101, '101st'],
      [111, '111th'],
      [1001, '1,001st'],
    ];

    for (const [value, expected] of cases) {
      expect(
        render('{server.member_count:ordinal}', { 'server.member_count': v.integer(value) }).output,
      ).toBe(expected);
    }
  });

  test(':ordinal is English, digits and grouping included, whatever the locale', () => {
    const ordinal = (value: number, locale: string): string =>
      render(
        '{server.member_count:ordinal}',
        { 'server.member_count': v.integer(value) },
        { locale },
      ).output;

    expect(ordinal(1001, 'de-DE')).toBe('1,001st');
    expect(ordinal(1_234_563, 'hi-IN')).toBe('1,234,563rd');
    expect(ordinal(22, 'ar-EG')).toBe('22nd');
    expect(ordinal(1001, 'ar-EG')).toBe('1,001st');
  });

  test(':percent writes a number as a percentage, and a percent is one already', () => {
    expect(render('{poll.share}', { 'poll.share': v.percent(64) }).output).toBe('64%');
    expect(render('{poll.share:percent}', { 'poll.share': v.percent(64) }).output).toBe('64%');
    expect(render('{stats.average:percent}', { 'stats.average': v.number(64.5) }).output).toBe(
      '64.5%',
    );
    expect(
      render('{server.member_count:percent}', { 'server.member_count': v.integer(12) }).output,
    ).toBe('12%');
  });
});

describe('text modifiers', () => {
  const name = (value: string) => ({ 'member.display_name': v.text(value) });

  test(':upper and :lower', () => {
    expect(render('{member.display_name:upper}', name('Ada Lovelace')).output).toBe('ADA LOVELACE');
    expect(render('{member.display_name:lower}', name('Ada Lovelace')).output).toBe('ada lovelace');
  });

  test('text is escaped after it is changed, not before', () => {
    expect(render('{member.display_name:upper}', name('a_b')).output).toBe('A\\_B');
  });

  test(':truncate(n) keeps n characters, the ellipsis included, and never splits one', () => {
    expect(render('{member.display_name:truncate(5)}', name('Lovelace')).output).toBe('Love…');
    expect(render('{member.display_name:truncate(5)}', name('Ada')).output).toBe('Ada');
    expect(render('{member.display_name:truncate(2)}', name('😀😀😀')).output).toBe('😀…');
  });

  test(':truncate never splits an emoji or accent made of several code points', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
    const accented = 'é';

    expect(render('{member.display_name:truncate(2)}', name(family.repeat(3))).output).toBe(
      `${family}…`,
    );
    expect(render('{member.display_name:truncate(2)}', name('🇩🇪🇫🇷🇮🇹')).output).toBe('🇩🇪…');
    expect(render('{member.display_name:truncate(3)}', name(accented.repeat(4))).output).toBe(
      `${accented.repeat(2)}…`,
    );
    expect(render('{member.display_name:truncate(3)}', name(family)).output).toBe(family);
  });

  test(':slug', () => {
    expect(render('{member.display_name:slug}', name('Ada Lovelace!')).output).toBe('ada-lovelace');
    expect(render('{member.display_name:slug}', name('Café Crème')).output).toBe('cafe-creme');
  });
});

describe('date and duration modifiers', () => {
  const joined = { 'member.joined_at': v.datetime(AT) };

  test('Discord renders dates in Discord text, in each reader’s own time zone', () => {
    expect(render('{member.joined_at}', joined).output).toBe(`<t:${UNIX}:f>`);
    expect(render('{member.joined_at:relative}', joined).output).toBe(`<t:${UNIX}:R>`);
    expect(render('{member.joined_at:full}', joined).output).toBe(`<t:${UNIX}:F>`);
    expect(render('{member.joined_at:date}', joined).output).toBe(`<t:${UNIX}:d>`);
    expect(render('{member.joined_at:time}', joined).output).toBe(`<t:${UNIX}:t>`);
  });

  test('everywhere else a date is readable text in the locale and time zone asked for', () => {
    expect(render('{member.joined_at:date}', joined, PLAIN).output).toBe('Nov 14, 2023');
    expect(render('{member.joined_at:time}', joined, PLAIN).output).toMatch(/^10:13\sPM$/u);
    expect(render('{member.joined_at}', joined, PLAIN).output).toMatch(
      /^Nov 14, 2023, 10:13\sPM$/u,
    );
    expect(
      render('{member.joined_at:full}', joined, { ...PLAIN, timeZone: 'America/New_York' }).output,
    ).toContain('Tuesday, November 14, 2023');
  });

  test(':relative is a phrase outside Discord text, measured from now', () => {
    expect(
      render('{member.joined_at:relative}', joined, { ...PLAIN, now: AT - 3 * HOUR }).output,
    ).toBe('in 3 hours');
    expect(
      render('{member.joined_at:relative}', joined, { ...PLAIN, now: new Date(AT + 49 * HOUR) })
        .output,
    ).toBe('2 days ago');
  });

  test(':unix is seconds, and can go in a link', () => {
    expect(render('{member.joined_at:unix}', joined).output).toBe(String(UNIX));
    expect(
      render('https://prtn.xyz/?t={member.joined_at:unix}', joined, { field: 'url' }).output,
    ).toBe(`https://prtn.xyz/?t=${UNIX}`);
  });

  test('durations are readable, with or without :duration', () => {
    const duration = (ms: number, template = '{giveaway.duration}'): string =>
      render(template, { 'giveaway.duration': v.duration(ms) }).output;

    expect(duration(7_500_000)).toBe('2h 5m');
    expect(duration(7_500_000, '{giveaway.duration:duration}')).toBe('2h 5m');
    expect(duration(90_061_000)).toBe('1d 1h');
    expect(duration(45_000)).toBe('45s');
    expect(duration(0)).toBe('0s');
  });
});

describe('list modifiers', () => {
  const OTHER = '323456789012345678';
  const THIRD = '423456789012345678';
  const roles = {
    'member.roles': v.list('mention', [
      v.role(ROLE, 'Mods'),
      v.role(OTHER, 'Admins'),
      v.role(THIRD, 'Staff'),
    ]),
  };

  test('a list is joined with a comma by default, or with :join', () => {
    expect(render('{member.roles}', roles).output).toBe(`<@&${ROLE}>, <@&${OTHER}>, <@&${THIRD}>`);
    expect(render('{member.roles:join(" | ")}', roles).output).toBe(
      `<@&${ROLE}> | <@&${OTHER}> | <@&${THIRD}>`,
    );
    expect(render('{member.roles}', roles, { field: 'plain_text' }).output).toBe(
      'Mods, Admins, Staff',
    );
  });

  test(':limit and :count', () => {
    expect(render('{member.roles:limit(2)}', roles).output).toBe(`<@&${ROLE}>, <@&${OTHER}>`);
    expect(render('{member.roles:count}', roles).output).toBe('3');
    expect(render('{member.roles:limit(2):count}', roles).output).toBe('2');
  });

  test('an empty list counts as zero, but an absent one is not a count at all', () => {
    const empty = { 'member.roles': v.list('mention', []) };

    expect(render('[{member.roles}]', empty).output).toBe('[]');
    expect(render('{member.roles:count}', empty).output).toBe('0');
    expect(render('[{member.roles:count}]', { 'member.roles': v.notSet() }).output).toBe('[]');
    expect(
      render('{member.roles:count:fallback("none")}', { 'member.roles': v.notSet() }).output,
    ).toBe('none');
  });
});

describe('booleans and :label', () => {
  test('a boolean is Yes or No, or the label given', () => {
    const boosting = (value: boolean, template: string): string =>
      render(template, { 'member.boosting': v.boolean(value) }).output;

    expect(boosting(true, '{member.boosting}')).toBe('Yes');
    expect(boosting(false, '{member.boosting}')).toBe('No');
    expect(boosting(true, '{member.boosting:label("on","off")}')).toBe('on');
    expect(boosting(false, '{member.boosting:label("on","off")}')).toBe('off');
  });
});

describe(':fallback', () => {
  test('stands in for an absent value only', () => {
    expect(
      render('{member.display_name:fallback("nobody")}', { 'member.display_name': v.notSet() })
        .output,
    ).toBe('nobody');
    expect(
      render('{member.display_name:fallback("nobody")}', { 'member.display_name': v.text('Ada') })
        .output,
    ).toBe('Ada');
  });

  test('is written by the admin, so it is neither escaped nor expanded', () => {
    expect(
      render('{member.display_name:fallback("**{server}** {{x}}")}', {
        'member.display_name': v.failed(),
      }).output,
    ).toBe('**{server}** {{x}}');
  });
});

describe('incompatible modifiers are reported and the value renders unmodified', () => {
  const values: Record<string, ResolvedValue> = {
    'member.display_name': v.text('Ada'),
    'member.mention': v.user(MEMBER),
    'server.member_count': v.integer(5),
    'member.roles': v.list('mention', []),
    'member.joined_at': v.datetime(AT),
    'member.boosting': v.boolean(true),
  };

  const cases: Array<[string, string, string]> = [
    ['{member.display_name:number}', 'Ada', 'incompatible_modifier'],
    ['{member.mention:upper}', `<@${MEMBER}>`, 'incompatible_modifier'],
    ['{server.member_count:relative}', '5', 'incompatible_modifier'],
    ['{member.roles:upper}', '', 'incompatible_modifier'],
    ['{member.boosting:join(", ")}', 'Yes', 'incompatible_modifier'],
    ['{member.joined_at:date:upper}', `<t:${UNIX}:d>`, 'incompatible_modifier'],
    ['{member.display_name:fallback("a"):fallback("b")}', 'Ada', 'incompatible_modifier'],
    ['{member.display_name:shout}', 'Ada', 'unknown_modifier'],
    ['{member.display_name:truncate("5")}', 'Ada', 'invalid_argument'],
    ['{member.display_name:truncate(0)}', 'Ada', 'invalid_argument'],
    ['{member.display_name:truncate(2.5)}', 'Ada', 'invalid_argument'],
    ['{member.display_name:upper(1)}', 'Ada', 'invalid_argument'],
    ['{member.roles:limit(51)}', '', 'invalid_argument'],
    ['{member.boosting:label("a")}', 'Yes', 'invalid_argument'],
  ];

  for (const [template, output, code] of cases) {
    test(template, () => {
      const rendered = render(template, values);

      expect(rendered.output).toBe(output);
      expect(codes(rendered)).toEqual([code]);
    });
  }

  test('a modifier that writes prose cannot go in a link', () => {
    const rendered = render('https://prtn.xyz/{server.member_count:number}', values, {
      field: 'url',
    });

    expect(rendered.output).toBe('https://prtn.xyz/5');
    expect(codes(rendered)).toEqual(['incompatible_modifier']);
  });

  test('a definition can narrow the modifiers it takes, though :fallback always applies', () => {
    const registry = createPlaceholderRegistry([
      define('member.bio', 'text', v.text('x'), { modifiers: ['truncate'] }),
    ]);
    const bio = (template: string, value: ResolvedValue) =>
      renderTemplate(template, lookupFrom({ 'member.bio': value }), {
        registry,
        field: 'plain_text',
      });

    const upper = bio('{member.bio:upper}', v.text('Hello'));
    expect(upper.output).toBe('Hello');
    expect(upper.diagnostics[0]?.message).toContain('does not take :upper');

    expect(bio('{member.bio:truncate(3)}', v.text('Hello')).output).toBe('He…');
    expect(bio('{member.bio:fallback("-")}', v.notSet()).output).toBe('-');
  });
});

describe('modifiersFor', () => {
  test('lists what a picker may offer for a type in a field', () => {
    expect(modifiersFor('datetime', 'url')).toEqual(['unix', 'fallback']);
    expect(modifiersFor('list<text>', 'discord_text')).toEqual([
      'fallback',
      'join',
      'limit',
      'count',
    ]);
    expect(modifiersFor('boolean', 'plain_text')).toEqual(['fallback', 'label']);
  });
});
