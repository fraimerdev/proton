import { describe, expect, test } from 'bun:test';
import {
  aliasFallbacks,
  aliasValues,
  definePlaceholderSurface,
  lookupFrom,
  mentionsAny,
  type PingKind,
  PlaceholderDefinitionError,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  type PlaceholderSurfaceInput,
  type ResolvedValue,
  renderTemplate,
  SHARED_PINGS,
  suggestKey,
  usedKeys,
  placeholderValue as v,
  withAvailability,
} from '../../src/placeholders/index.ts';
import { AT, codes, define, MEMBER } from './harness.ts';

interface Facts {
  name: string | null;
  count?: number;
}

const DEFINITIONS: PlaceholderDefinitionInput[] = [
  define('user.mention', 'mention', v.user(MEMBER, 'Ada'), { aliases: ['user'] }),
  define('user.nickname', 'text', v.text('Ada')),
  define('user.joined_at', 'datetime', v.datetime(AT)),
  define('server.name', 'text', v.text('Proton'), { aliases: ['server'] }),
  define('server.member_count', 'integer', v.integer(1), { aliases: ['memberCount'] }),
  define('server.icon_url', 'image_url', v.imageUrl('https://cdn.discordapp.com/icons/1/a.png')),
  define('ticket.subject', 'text', v.text('Refund'), { sensitivity: 'member_private' }),
  define('ticket.answer.<question_key>', 'text', v.text('1182')),
  withAvailability(define('boost.tier', 'integer', v.integer(2)), ['test.boost']),
];

function input(
  overrides: Partial<PlaceholderSurfaceInput<Facts>> = {},
): PlaceholderSurfaceInput<Facts> {
  return {
    id: 'test.greeting',
    module: 'test',
    label: 'Greeting',
    event: 'test.join',
    audience: 'public',
    fields: [
      { path: 'message.content', kind: 'discord_text', label: 'Message text', limit: 2000 },
      { path: 'message.embeds.*.url', kind: 'url', label: 'Embed title link' },
      { path: 'channels.*.name', kind: 'channel_name', channel: 'voice', label: 'Channel name' },
    ],
    definitions: DEFINITIONS,
    build: (facts) =>
      lookupFrom({
        'user.mention': v.user(MEMBER, 'Ada'),
        'server.name': facts.name === null ? v.unavailable() : v.text(facts.name),
        'server.member_count': facts.count === undefined ? v.unavailable() : v.integer(facts.count),
      }),
    samples: [{ id: 'member', label: 'Sample: Ada joining Proton', facts: { name: 'Proton' } }],
    pings: SHARED_PINGS,
    ...overrides,
  };
}

const surface = definePlaceholderSurface(input());

function renderOn(
  template: string,
  lookup: PlaceholderLookup,
  target: PlaceholderSurface<Facts> = surface,
) {
  return renderTemplate(template, lookup, {
    registry: target.registry,
    field: 'discord_text',
    event: target.event,
    audience: target.audience,
  });
}

describe('definePlaceholderSurface', () => {
  test('builds one registry from its definitions and keeps what it was given', () => {
    expect(surface.registry.resolve('server')?.canonical).toBe('server.name');
    expect(surface.definitions.map(({ key }) => key)).toEqual(DEFINITIONS.map(({ key }) => key));
    expect(surface.samples[0]?.label).toBe('Sample: Ada joining Proton');
    expect(surface.pings).toEqual(SHARED_PINGS);
    expect(Object.isFrozen(surface)).toBe(true);
  });

  test('a bad definition fails when the surface is defined, naming the surface', () => {
    const clash = [
      ...DEFINITIONS,
      define('member.name', 'text', v.text('x'), { aliases: ['server'] }),
    ];

    expect(() => definePlaceholderSurface(input({ definitions: clash }))).toThrow(
      PlaceholderDefinitionError,
    );
    expect(() => definePlaceholderSurface(input({ definitions: clash }))).toThrow(
      /'test\.greeting'.*claimed by both/,
    );
  });

  test('refuses a surface it could not render or name', () => {
    const refused: Array<Partial<PlaceholderSurfaceInput<Facts>>> = [
      { id: 'Test Greeting' },
      { module: 'Test' },
      { event: 'not an event' },
      { label: '  ' },
      { fields: [{ path: 'channels.*.name', kind: 'channel_name', label: 'Name' }] },
      {
        fields: [
          { path: 'message.content', kind: 'discord_text', label: 'Text' },
          { path: 'message.content', kind: 'plain_text', label: 'Text' },
        ],
      },
      { fields: [{ path: 'message..content', kind: 'discord_text', label: 'Text' }] },
      { fields: [{ path: 'message.content', kind: 'discord_text', label: 'Text', limit: 0 }] },
      {
        fields: [
          { path: 'message.content', kind: 'discord_text', channel: 'voice', label: 'Text' },
        ],
      },
      { fields: [{ path: 'message.content', kind: 'discord_text', label: '' }] },
      {
        samples: [
          { id: 'member', label: 'One', facts: { name: 'A' } },
          { id: 'member', label: 'Two', facts: { name: 'B' } },
        ],
      },
      { pings: { 'server.name': 'roles' } },
      { pings: { 'user.mention': 'everyone' } as unknown as Record<string, PingKind> },
    ];

    for (const overrides of refused) {
      expect(() => definePlaceholderSurface(input(overrides))).toThrow(PlaceholderDefinitionError);
    }
  });

  test('a ping key the surface does not register is ignored, so the shared map spreads anywhere', () => {
    expect(() =>
      definePlaceholderSurface(input({ pings: { ...SHARED_PINGS, 'nobody.mention': 'users' } })),
    ).not.toThrow();
  });

  test('a surface typed by its facts fits wherever any surface is expected', () => {
    const any: PlaceholderSurface<unknown> = surface;
    expect(usedKeys(any, ['{server}'])).toEqual(new Set(['server.name']));
  });
});

describe('fields and the picker', () => {
  test('fieldAt matches * against array indexes only', () => {
    expect(surface.fieldAt('message.embeds.0.url')?.label).toBe('Embed title link');
    expect(surface.fieldAt('channels.12.name')?.channel).toBe('voice');
    expect(surface.fieldAt('message.embeds.first.url')).toBeUndefined();
    expect(surface.fieldAt('message.content.extra')).toBeUndefined();
    expect(surface.fieldAt('message')).toBeUndefined();
  });

  test('pickerFor offers only what the field can show, here, to this audience', () => {
    const keys = (path: string) => surface.pickerFor(path).map(({ key }) => key);

    expect(keys('message.content')).toEqual([
      'user.mention',
      'user.nickname',
      'user.joined_at',
      'server.name',
      'server.member_count',
      'server.icon_url',
      'ticket.answer.<question_key>',
    ]);
    expect(keys('message.embeds.3.url')).toEqual([
      'user.nickname',
      'server.name',
      'server.member_count',
      'server.icon_url',
      'ticket.answer.<question_key>',
    ]);
    expect(keys('message.unknown')).toEqual([]);
  });

  test('restricted data is refused before it is ever looked up', () => {
    let asked = 0;
    const rendered = renderOn('[{ticket.subject}]', () => {
      asked += 1;
      return v.text('Refund for order 1182');
    });

    expect(rendered.output).toBe('[]');
    expect(codes(rendered)).toEqual(['restricted']);
    expect(asked).toBe(0);

    const staff = definePlaceholderSurface(input({ id: 'test.review', audience: 'staff_only' }));
    expect(renderOn('{ticket.subject}', () => v.text('Refund'), staff).output).toBe('Refund');
  });
});

describe('alias fallbacks and overrides', () => {
  const FALLBACKS = { server: v.text('this server'), memberCount: v.integer(0) };

  test('a fallback fills in only for the alias, and only when the value is absent', () => {
    const missing = aliasFallbacks(surface.build({ name: null }, { now: AT }), FALLBACKS);

    expect(renderOn('{server} has {memberCount}', missing).output).toBe('this server has 0');

    const canonical = renderOn('[{server.name}][{server.member_count}]', missing);
    expect(canonical.output).toBe('[][]');
    expect(codes(canonical)).toEqual(['unavailable', 'unavailable']);

    const present = aliasFallbacks(surface.build({ name: '', count: 0 }, { now: AT }), FALLBACKS);
    expect(renderOn('[{server}][{memberCount}]', present).output).toBe('[][0]');
  });

  test('every absent state takes the fallback', () => {
    for (const absent of [v.notSet(), v.failed('boom'), v.unknownKey()]) {
      const lookup = aliasFallbacks(lookupFrom({ 'server.name': absent }), FALLBACKS);
      expect(renderOn('{server}', lookup).output).toBe('this server');
    }
  });

  test('an override replaces the alias value and leaves the canonical key alone', () => {
    const owner = '100000000000000099';
    const lookup = aliasValues(lookupFrom({ 'user.mention': v.user(MEMBER, 'Ada') }), {
      user: v.user(owner),
    });

    expect(renderOn('{user} {user.mention}', lookup).output).toBe(`<@${owner}> <@${MEMBER}>`);
  });

  test('an inherited entry is never a fallback or an override', () => {
    const inherited: Record<string, ResolvedValue> = Object.create({
      server: v.text('inherited'),
    });
    const missing = surface.build({ name: null }, { now: AT });

    expect(renderOn('[{server}]', aliasFallbacks(missing, inherited)).output).toBe('[]');
    expect(renderOn('[{server}]', aliasValues(missing, inherited)).output).toBe('[]');
  });

  test('prototype names never resolve, even when the tables hold them as own keys', () => {
    const polluted: Record<string, ResolvedValue> = JSON.parse(
      '{"__proto__":{"type":"text","value":"x"},"constructor":{"type":"text","value":"x"},"toString":{"type":"text","value":"x"}}',
    );
    const lookup = aliasValues(aliasFallbacks(lookupFrom(polluted), polluted), polluted);
    const template = '{constructor} {__proto__} {server.constructor} {toString} {hasOwnProperty}';
    const rendered = renderOn(template, lookup);

    expect(rendered.output).toBe(template);
    expect(codes(rendered)).toEqual([
      'forbidden_key',
      'forbidden_key',
      'forbidden_key',
      'unknown_placeholder',
      'unknown_placeholder',
    ]);
  });
});

describe('usedKeys, mentionsAny and suggestKey', () => {
  test('usedKeys collects canonical keys, through aliases and dynamic segments', () => {
    expect(
      usedKeys(surface, [
        '{user} and {server.name:upper}',
        '{{server}} {nope} {ticket.answer.order}',
        '{constructor}',
      ]),
    ).toEqual(new Set(['user.mention', 'server.name', 'ticket.answer.order']));
  });

  test('usedKeys can leave out what this surface refuses, so nothing is read for it', () => {
    const definitions = [
      ...DEFINITIONS,
      define('card.caption', 'text', v.text('Hi'), { availability: { fields: ['plain_text'] } }),
    ];
    const templates = [
      '{server} {boost.tier} {ticket.subject:upper}',
      '{ticket.answer.order} {card.caption} {nope}',
    ];
    const everything = new Set([
      'server.name',
      'boost.tier',
      'ticket.subject',
      'ticket.answer.order',
      'card.caption',
    ]);
    const greeting = definePlaceholderSurface(input({ definitions }));

    expect(usedKeys(greeting, templates)).toEqual(everything);
    expect(usedKeys(greeting, templates, { allowedOnly: true })).toEqual(
      new Set(['server.name', 'ticket.answer.order']),
    );

    const review = definePlaceholderSurface(
      input({
        id: 'test.review',
        event: 'test.boost',
        audience: 'staff_only',
        fields: [{ path: 'note', kind: 'plain_text', label: 'Note' }],
        definitions,
      }),
    );

    expect(usedKeys(review, templates, { allowedOnly: true })).toEqual(everything);
  });

  test('mentionsAny finds a key written as an alias or in full, never an escaped one', () => {
    const counts = ['server.member_count'];

    expect(mentionsAny(surface, '{memberCount} online', counts)).toBe(true);
    expect(mentionsAny(surface, '{server.member_count:number} online', counts)).toBe(true);
    expect(mentionsAny(surface, '{{memberCount}} online', counts)).toBe(false);
    expect(mentionsAny(surface, '{memberCount online', counts)).toBe(false);
    expect(mentionsAny(surface, '{server}', counts)).toBe(false);
  });

  test('suggestKey offers the closest key or alias within two edits', () => {
    expect(suggestKey(surface.registry, 'user.nicknam')).toBe('user.nickname');
    expect(suggestKey(surface.registry, 'servr')).toBe('server');
    expect(suggestKey(surface.registry, 'membercount')).toBe('memberCount');
    expect(suggestKey(surface.registry, 'user.nickname')).toBeUndefined();
    expect(suggestKey(surface.registry, 'weather.today')).toBeUndefined();
    expect(suggestKey(surface.registry, 'ticket.answer')).toBeUndefined();
  });
});
