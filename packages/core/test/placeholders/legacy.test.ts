import { describe, expect, test } from 'bun:test';
import { substitute, type TemplateVars } from '../../src/messages/template.ts';
import {
  type ChannelKind,
  createPlaceholderRegistry,
  lookupFrom,
  type PlaceholderDefinitionInput,
  type ResolvedValue,
  renderTemplate,
  type TemplateField,
  placeholderValue as v,
} from '../../src/placeholders/index.ts';
import { codes, define, MEMBER, render } from './harness.ts';

function engine(
  definitions: PlaceholderDefinitionInput[],
  values: Record<string, ResolvedValue>,
  field: TemplateField,
  channel?: ChannelKind,
): (template: string) => string {
  const registry = createPlaceholderRegistry(definitions);
  return (template) =>
    renderTemplate(template, lookupFrom(values), { registry, field, channel }).output;
}

function legacy(template: string, vars: TemplateVars): string {
  const rendered = substitute(template, vars);
  return typeof rendered === 'string' ? rendered : '';
}

const WELCOME_DEFINITIONS = [
  define('member.mention', 'mention', v.user(MEMBER), { aliases: ['user'] }),
  define('member.display_name', 'text', v.text('Ada'), { aliases: ['username'] }),
  define('server.name', 'text', v.text('Proton'), { aliases: ['server'] }),
  define('server.member_count', 'integer', v.integer(1), { aliases: ['memberCount'] }),
];

const WELCOME_TEMPLATES = [
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

const WELCOME_FACTS = [
  { username: 'Newcomer', guildName: 'Proton', memberCount: 42 },
  {
    username: '_New*comer*_ `x` <@1> [a](b) {server}',
    guildName: '**Proton** {user} # not a heading',
    memberCount: 0,
  },
  { username: '', guildName: 'P'.repeat(300), memberCount: 1_234_567 },
];

describe('welcome, goodbye and boost greetings', () => {
  for (const [index, facts] of WELCOME_FACTS.entries()) {
    test(`render byte-identically through {user} {username} {server} {memberCount} (#${index + 1})`, () => {
      const vars = {
        user: `<@${MEMBER}>`,
        username: facts.username,
        server: facts.guildName,
        memberCount: String(facts.memberCount),
      };
      const next = engine(
        WELCOME_DEFINITIONS,
        {
          'member.mention': v.user(MEMBER),
          'member.display_name': v.text(facts.username),
          'server.name': v.text(facts.guildName),
          'server.member_count': v.integer(facts.memberCount),
        },
        'discord_text',
      );

      for (const template of WELCOME_TEMPLATES) expect(next(template)).toBe(legacy(template, vars));
    });
  }
});

const HONEYPOT_TEMPLATES = [
  'This channel is used to catch spam bots and compromised accounts, which post in every ' +
    'channel they can see. Any message sent here means **{consequence}**.{purge}\n\n' +
    'There is never a reason to post here.',
  'Nobody has any reason to post in this channel. Anything sent here means **{consequence}**.' +
    '{purge}\n\nThere is never a reason to post here.',
  'A message was sent from your account in **{server}**, in a channel that exists only to catch ' +
    'spam bots. You were **{action}** as a result.',
];

describe('honeypot notice and direct message', () => {
  for (const purge of [' Everything you posted in 1 day is deleted with you.', '']) {
    test(`render byte-identically through {consequence} {purge} {server} {action} (purge ${purge ? 'on' : 'off'})`, () => {
      const vars = {
        consequence: 'you are banned from the server',
        purge,
        server: 'Proton_Test *',
        action: 'removed from the server, and can rejoin straight away',
      };
      const next = engine(
        [
          define('honeypot.consequence', 'markdown', v.markdown('x'), { aliases: ['consequence'] }),
          define('honeypot.purge', 'markdown', v.markdown('x'), { aliases: ['purge'] }),
          define('server.name', 'text', v.text('x'), { aliases: ['server'] }),
          define('honeypot.action', 'markdown', v.markdown('x'), { aliases: ['action'] }),
        ],
        {
          'honeypot.consequence': v.markdown(vars.consequence),
          'honeypot.purge': v.markdown(vars.purge),
          'server.name': v.text(vars.server),
          'honeypot.action': v.markdown(vars.action),
        },
        'discord_text',
      );

      for (const template of HONEYPOT_TEMPLATES) {
        expect(next(template)).toBe(legacy(template, vars));
      }
    });
  }
});

const LEVEL_UP_TEMPLATES = [
  '{user} reached level {level}.',
  'GG {user}, level {level} at {xp} XP!',
  '{rank} of {level}',
  'Level {level}',
  '{user} is on {xp} XP.',
  '{xp} XP',
];

describe('level-up announcements', () => {
  for (const values of [
    { level: 5, xp: 1234 },
    { level: 0, xp: 0 },
    { level: 100, xp: Number.MAX_SAFE_INTEGER },
  ]) {
    test(`render byte-identically through {user} {level} {xp} (level ${values.level})`, () => {
      const vars = { user: `<@${MEMBER}>`, level: values.level, xp: values.xp };
      const next = engine(
        [
          define('member.mention', 'mention', v.user(MEMBER), { aliases: ['user'] }),
          define('leveling.level', 'integer', v.integer(1), { aliases: ['level'] }),
          define('leveling.xp', 'integer', v.integer(1), { aliases: ['xp'] }),
        ],
        {
          'member.mention': v.user(MEMBER),
          'leveling.level': v.integer(values.level),
          'leveling.xp': v.integer(values.xp),
        },
        'discord_text',
      );

      for (const template of LEVEL_UP_TEMPLATES) {
        expect(next(template)).toBe(legacy(template, vars));
      }
    });
  }
});

describe('ticket opening message', () => {
  test('renders byte-identically through {user}', () => {
    const legacyOpening = (template: string): string =>
      template.split('{user}').join(`<@${MEMBER}>`).slice(0, 2000);
    const next = engine(
      [define('member.mention', 'mention', v.user(MEMBER), { aliases: ['user'] })],
      { 'member.mention': v.user(MEMBER) },
      'discord_text',
    );

    for (const template of [
      'Thanks for getting in touch, {user}. Describe the problem below.',
      'hello {user}',
      '{user}{user} {users} {user.x}',
      `${'x'.repeat(1990)}{user}`,
    ]) {
      expect(next(template).slice(0, 2000)).toBe(legacyOpening(template));
    }
  });
});

function sanitiseTicketName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);

  return cleaned === '' ? 'ticket' : cleaned;
}

function legacyTicketName(pattern: string, number: number, opener: string, type: string): string {
  return sanitiseTicketName(
    pattern
      .split('{number}')
      .join(String(number))
      .split('{user}')
      .join(opener)
      .split('{type}')
      .join(type),
  );
}

const TICKET_DEFINITIONS = [
  define('ticket.number', 'integer', v.integer(1), { aliases: ['number'] }),
  define('ticket.opener_name', 'text', v.text('x'), { aliases: ['user'] }),
  define('ticket.type_name', 'text', v.text('x'), { aliases: ['type'] }),
];

describe('ticket channel names', () => {
  const patterns = [
    'ticket-{number}',
    '{type}-{number}-{user}',
    'ticket-{user}',
    `${'a'.repeat(200)}-{number}`,
    '!!!',
    '{nobody}-{number}',
  ];

  for (const [opener, type] of [
    ['Fraimer', 'Billing'],
    ['a!!!b   c', ''],
    [MEMBER, 'Bug Report'],
  ] as const) {
    test(`render byte-identically when the module keeps its own sanitiser (${opener})`, () => {
      const next = engine(
        TICKET_DEFINITIONS,
        {
          'ticket.number': v.integer(7),
          'ticket.opener_name': v.text(opener),
          'ticket.type_name': v.text(type),
        },
        'plain_text',
      );

      for (const pattern of patterns) {
        expect(sanitiseTicketName(next(pattern))).toBe(legacyTicketName(pattern, 7, opener, type));
      }
    });
  }

  test('the engine’s own text channel normalisation agrees on ordinary names', () => {
    const next = engine(
      TICKET_DEFINITIONS,
      {
        'ticket.number': v.integer(7),
        'ticket.opener_name': v.text('Fraimer'),
        'ticket.type_name': v.text('Billing'),
      },
      'channel_name',
      'text',
    );

    expect(next('{type}-{number}-{user}')).toBe(
      legacyTicketName('{type}-{number}-{user}', 7, 'Fraimer', 'Billing'),
    );
    expect(next('ticket-{number}')).toBe('ticket-7');
  });
});

function legacyTempVcName(template: string, displayName: string, username: string): string {
  const filled = template
    .split('{displayName}')
    .join(displayName)
    .split('{user}')
    .join(displayName)
    .split('{username}')
    .join(username)
    .split('{userId}')
    .join(MEMBER)
    .trim();

  return (filled.length === 0 ? displayName : filled).slice(0, 100);
}

describe('temporary voice channel names', () => {
  const templates = [
    '{user}’s channel',
    '{displayName} {username} {userId}',
    '{user} and {user}',
    '{user}',
    '{username}',
    '  {user}  ',
    'Room of {user} ({userId})',
  ];

  for (const [displayName, username] of [
    ['Ada', 'ada'],
    ['x'.repeat(500), 'ada'],
    ['Ada', ''],
    ['Ada Lovelace', 'ada.l_'],
  ] as const) {
    test(`render byte-identically through {user} {displayName} {username} {userId} (${displayName.slice(0, 12)})`, () => {
      const next = engine(
        [
          define('member.display_name', 'text', v.text('x'), { aliases: ['user', 'displayName'] }),
          define('member.username', 'text', v.text('x'), { aliases: ['username'] }),
          define('member.id', 'text', v.text('x'), { aliases: ['userId'] }),
        ],
        {
          'member.display_name': v.text(displayName),
          'member.username': v.text(username),
          'member.id': v.text(MEMBER),
        },
        'channel_name',
        'voice',
      );

      for (const template of templates) {
        const rendered = next(template);
        const named = rendered === '' ? displayName.slice(0, 100) : rendered;

        expect(named).toBe(legacyTempVcName(template, displayName, username));
      }
    });
  }
});

describe('counter channel names', () => {
  const templates = [
    'Members: {count}',
    '{count} of {count}',
    '{members} online — {count}',
    'Nothing here',
    `${'x'.repeat(100)}{count}`,
    `${'x'.repeat(93)}{count}`,
  ];

  for (const count of [0, 7, 1234, 999_999_999]) {
    test(`render byte-identically through {count} (${count})`, () => {
      const next = engine(
        [define('counter.count', 'integer', v.integer(1), { aliases: ['count'] })],
        { 'counter.count': v.integer(count) },
        'channel_name',
        'voice',
      );

      for (const template of templates) {
        expect(next(template)).toBe(template.split('{count}').join(String(count)).slice(0, 100));
      }
    });
  }
});

describe('deliberate departures from the legacy renderers', () => {
  const vars = { user: `<@${MEMBER}>` };
  const values = { 'member.mention': v.user(MEMBER) };

  test('{{ and }} are escapes now, so {{user}} is the literal text {user}', () => {
    expect(legacy('{{user}}', vars)).toBe(`{<@${MEMBER}>}`);
    expect(render('{{user}}', values).output).toBe('{user}');
    expect(render('{{{user}}}', values).output).toBe(`{<@${MEMBER}>}`);
  });

  test('a modifier after a legacy token is parsed now instead of being left as written', () => {
    expect(legacy('{user:upper}', vars)).toBe('{user:upper}');

    const rendered = render('{user:upper}', values);
    expect(rendered.output).toBe(`<@${MEMBER}>`);
    expect(codes(rendered)).toEqual(['incompatible_modifier']);
  });

  test('a value is never expanded again, which the split-and-join renderers did', () => {
    const hostile = {
      'member.display_name': v.text('{username}'),
      'member.username': v.text('ada'),
    };
    const next = engine(
      [
        define('member.display_name', 'text', v.text('x'), { aliases: ['user', 'displayName'] }),
        define('member.username', 'text', v.text('x'), { aliases: ['username'] }),
      ],
      hostile,
      'channel_name',
      'voice',
    );

    expect(legacyTempVcName('{user}', '{username}', 'ada')).toBe('ada');
    expect(next('{user}')).toBe('{username}');
  });

  test('a value can no longer post @everyone or @here, which substitute let through', () => {
    const next = engine(
      WELCOME_DEFINITIONS,
      { 'member.display_name': v.text('@everyone'), 'server.name': v.text('here') },
      'discord_text',
    );

    expect(legacy('{username} @{server}', { username: '@everyone', server: 'here' })).toBe(
      '@everyone @here',
    );
    expect(next('{username} @{server}')).toBe('@​everyone @​here');
  });

  test('text channel names drop punctuation where the tickets sanitiser turned it into dashes', () => {
    const next = engine(
      TICKET_DEFINITIONS,
      { 'ticket.opener_name': v.text('a!!!b   c') },
      'channel_name',
      'text',
    );

    expect(legacyTicketName('ticket-{user}', 1, 'a!!!b   c', '')).toBe('ticket-a-b-c');
    expect(next('ticket-{user}')).toBe('ticket-ab-c');
  });
});
