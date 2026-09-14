import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  CHANNEL_KINDS,
  escapeTemplateText,
  lookupFrom,
  PLACEHOLDER_LIMITS,
  type PlaceholderLookup,
  type ResolvedValue,
  renderTemplate,
  TEMPLATE_FIELDS,
  placeholderValue as v,
} from '../../src/placeholders/index.ts';
import { AT, MEMBER, ROLE, registry } from './harness.ts';

const PRESENT: Record<string, ResolvedValue> = {
  'member.mention': v.user(MEMBER, 'Ada'),
  'member.display_name': v.text('Ada_*'),
  'member.id': v.text(MEMBER),
  'member.joined_at': v.datetime(AT),
  'member.boosting': v.boolean(false),
  'member.roles': v.list('mention', [v.role(ROLE)]),
  'server.name': v.text('Proton'),
  'server.member_count': v.integer(0),
  'server.icon_url': v.imageUrl('https://cdn.discordapp.com/icons/1/a.png'),
  'stats.average': v.number(1.5),
  'poll.share': v.percent(64),
  'giveaway.duration': v.duration(0),
  'giveaway.winners': v.list('text', []),
  'rules.body': v.markdown('**Be kind**'),
  'appeal.link': v.url('https://prtn.xyz/appeal'),
  'answer.reason': v.text('hacked'),
  'case.note': v.text('watch'),
  'boost.tier': v.integer(2),
  'card.caption': v.text('Hi'),
};

const fieldArb = fc.constantFrom(...TEMPLATE_FIELDS);
const channelArb = fc.constantFrom(...CHANNEL_KINDS);

const noisyTemplateArb = fc.oneof(
  fc.string({
    unit: fc.constantFrom(
      '{',
      '}',
      '{{',
      '}}',
      ':',
      '(',
      ')',
      '"',
      '\\',
      ',',
      ' ',
      'a',
      '_',
      '.',
      '-',
      '5',
      'user',
      'server',
      'member.display_name',
      'member.roles',
      'member.joined_at',
      'answer.x',
      'constructor',
      '__proto__',
      'truncate',
      'fallback',
      'limit',
      'count',
      'label',
      'upper',
      'date',
      'relative',
      'join',
      '"x"',
      '(3)',
      'https://',
    ),
    maxLength: 60,
  }),
  fc.string({ unit: 'binary', maxLength: 80 }),
);

const absentArb: fc.Arbitrary<ResolvedValue> = fc.constantFrom(
  v.unknownKey(),
  v.unavailable(),
  v.notSet(),
  v.restricted(),
  v.failed(),
  v.failed('why'),
);

const lookupArb: fc.Arbitrary<PlaceholderLookup> = fc.oneof(
  fc.constant(lookupFrom(PRESENT)),
  absentArb.map((value) => () => value),
  fc.constant((): ResolvedValue => {
    throw new Error('boom');
  }),
  fc.jsonValue().map((junk) => (): ResolvedValue => JSON.parse(JSON.stringify(junk))),
);

describe('rendering properties', () => {
  test('rendering never throws, whatever the template, field, channel, locale or lookup', () => {
    fc.assert(
      fc.property(
        noisyTemplateArb,
        fieldArb,
        channelArb,
        lookupArb,
        fc.constantFrom('en-US', 'de-DE', 'not a locale!!'),
        (template, field, channel, lookup, locale) => {
          const rendered = renderTemplate(template, lookup, {
            registry,
            field,
            channel,
            locale,
            now: AT,
          });

          expect(typeof rendered.output).toBe('string');
          expect(rendered.output.length).toBeLessThanOrEqual(PLACEHOLDER_LIMITS.outputLength);
        },
      ),
      { numRuns: 500 },
    );
  });

  test('a template without braces comes back unchanged in Discord and plain text', () => {
    fc.assert(
      fc.property(
        fc
          .string({ unit: 'binary', maxLength: 200 })
          .filter((template) => !template.includes('{') && !template.includes('}')),
        fc.constantFrom('discord_text', 'plain_text'),
        (template, field) => {
          const rendered = renderTemplate(template, lookupFrom(PRESENT), { registry, field });

          expect(rendered.output).toBe(template);
          expect(rendered.diagnostics).toEqual([]);
        },
      ),
    );
  });

  test('escaped text round-trips, braces and all', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({
            unit: fc.constantFrom('{', '}', '{{', '}}', 'user', ':', ' ', '"'),
            maxLength: 80,
          }),
          fc.string({ unit: 'binary', maxLength: 120 }),
        ),
        fc.constantFrom('discord_text', 'plain_text'),
        (text, field) => {
          const rendered = renderTemplate(escapeTemplateText(text), lookupFrom(PRESENT), {
            registry,
            field,
          });

          expect(rendered.output).toBe(text);
          expect(rendered.diagnostics).toEqual([]);
        },
      ),
    );
  });

  test('in Discord text no value ever completes @everyone or @here', () => {
    const wordArb = fc.string({
      unit: fc.constantFrom(
        '@',
        'every',
        'one',
        'everyone',
        'here',
        'HERE',
        'Everyone',
        'x',
        ' ',
        '*',
      ),
      maxLength: 8,
    });
    const templateArb = fc
      .array(
        fc.constantFrom(
          '{member.display_name}',
          '{username}',
          '{rules.body}',
          '{appeal.link}',
          '{giveaway.winners}',
          '{giveaway.winners:join("@")}',
          'every',
          'one',
          'here',
          ' ',
          'x',
        ),
        { maxLength: 10 },
      )
      .map((parts) => parts.join(''));

    fc.assert(
      fc.property(
        templateArb,
        wordArb,
        wordArb,
        wordArb,
        fc.array(wordArb, { maxLength: 4 }),
        (template, name, body, path, winners) => {
          const { output } = renderTemplate(
            template,
            lookupFrom({
              'member.display_name': v.text(name),
              'rules.body': v.markdown(body),
              'appeal.link': v.url(`https://x.co/${path}`),
              'giveaway.winners': v.list(
                'text',
                winners.map((winner) => v.text(winner)),
              ),
            }),
            { registry, field: 'discord_text' },
          );

          expect(output).not.toMatch(/@(everyone|here)/i);
        },
      ),
      { numRuns: 500 },
    );
  });

  test('neither absent nor present values ever write undefined, null or [object Object]', () => {
    const placeholderArb = fc.constantFrom(
      '{user}',
      '{username}',
      '{member.display_name:upper:truncate(3)}',
      '{member.roles}',
      '{member.roles:count}',
      '{member.roles:join(", ")}',
      '{member.joined_at}',
      '{member.joined_at:relative}',
      '{member.joined_at:unix}',
      '{server.member_count:number}',
      '{poll.share:percent}',
      '{member.boosting}',
      '{member.boosting:label("a","b")}',
      '{giveaway.duration:duration}',
      '{giveaway.winners}',
      '{appeal.link}',
      '{answer.reason}',
      '{option.x.votes:ordinal}',
      '{case.note}',
      '{boost.tier}',
      '{card.caption}',
      '{rules.body}',
      '{server.icon_url}',
      '{stats.average:compact}',
    );
    const templateArb = fc
      .array(
        fc.oneof(placeholderArb, fc.constantFrom(' ', '-', 'x', '!', '/', 'https://prtn.xyz/')),
        {
          maxLength: 12,
        },
      )
      .map((parts) => parts.join(''));
    const lookupsArb: fc.Arbitrary<PlaceholderLookup> = fc.oneof(
      absentArb.map((value) => () => value),
      fc.constant(lookupFrom(PRESENT)),
    );

    fc.assert(
      fc.property(
        templateArb,
        fieldArb,
        channelArb,
        lookupsArb,
        (template, field, channel, lookup) => {
          const { output } = renderTemplate(template, lookup, {
            registry,
            field,
            channel,
            audience: 'staff_only',
            event: 'member.boosted',
            now: AT,
          });

          for (const junk of ['undefined', 'null', '[object Object]']) {
            expect(output).not.toContain(junk);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
