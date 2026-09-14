import { describe, expect, test } from 'bun:test';
import { encodeCustomId, newId } from '@proton/core';
import {
  formatTemplateIssues,
  type PlaceholderEnvironment,
  type PlaceholderLookup,
  type PlaceholderSurface,
  renderTemplate,
  SAMPLE_NOW,
  placeholderValue as v,
  validateConfigTemplates,
  validateTemplate,
} from '@proton/core/placeholders';
import {
  renderChannelName,
  renderOpeningMessage,
  ticketsConfigSchema,
  ticketTypeSchema,
} from '../src/config.ts';
import { defaultName } from '../src/controls.ts';
import { PROTON_ACTOR, type TicketsDeps } from '../src/deps.ts';
import { createTicketsModule } from '../src/index.ts';
import { closeTicket, mayOpen } from '../src/lifecycle.ts';
import {
  renderTicketChannelName,
  renderTicketText,
  renderTicketWelcome,
  TICKET_BLACKLIST_SURFACE,
  TICKET_CLOSE_SURFACE,
  TICKET_NAME_SURFACE,
  TICKET_RESPONSE_SURFACE,
  TICKET_WELCOME_SURFACE,
  type TicketNameFacts,
  type TicketPlaceholderFacts,
  type TicketRecordFacts,
  ticketSourcesFor,
  ticketsTemplates,
} from '../src/placeholders.ts';
import {
  BOT,
  CREATED,
  GUILD,
  HELPER,
  harness,
  MEMBER,
  MOD,
  OTHER_HELPER,
  PANEL,
  PANEL_MESSAGE,
  pressEvent,
  STAFF,
  stringOption,
  subcommand,
  TYPE,
  userOption,
} from './harness.ts';

const ZERO_WIDTH_SPACE = '​';
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const DEFAULT_WELCOME = 'Thanks for getting in touch, {user}. Describe the problem below.';

function customId(action: string, ...args: string[]): string {
  const encoded = encodeCustomId('tickets', action, ...args);
  if (!encoded.ok) throw new Error(encoded.humanReason);
  return encoded.customId;
}

const OPEN = customId('ot', PANEL.id, TYPE.id);

function legacySanitise(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);

  return cleaned === '' ? 'ticket' : cleaned;
}

function legacyName(pattern: string, number: number, opener: string, typeName: string): string {
  return legacySanitise(
    pattern
      .split('{number}')
      .join(String(number))
      .split('{user}')
      .join(opener)
      .split('{type}')
      .join(typeName),
  );
}

function legacyOpening(template: string, userId: string): string {
  return template.split('{user}').join(`<@${userId}>`).slice(0, 2000);
}

function record(overrides: Partial<TicketRecordFacts> = {}): TicketRecordFacts {
  return {
    id: 'ticket-row',
    number: 7,
    priority: 'high',
    subject: 'Refund for order 1182',
    openedAt: new Date(SAMPLE_NOW - 3_600_000),
    ownerId: MEMBER,
    openerId: MEMBER,
    channelId: CREATED,
    claimedById: null,
    assignedToId: null,
    ...overrides,
  };
}

function nameFacts(opener: string, typeName: string): TicketNameFacts {
  return { number: 7, typeName, ownerId: MEMBER, legacyUserName: opener, server: null };
}

function facts(overrides: Partial<TicketPlaceholderFacts> = {}): TicketPlaceholderFacts {
  return {
    ticket: record(),
    typeName: 'Billing',
    ownerId: MEMBER,
    server: null,
    bot: null,
    ...overrides,
  };
}

function codesOn(surface: PlaceholderSurface<unknown>, text: string): string[] {
  return validateTemplate(text, {
    registry: surface.registry,
    field: surface.fields[0]?.kind ?? 'plain_text',
    event: surface.event,
    audience: surface.audience,
  }).diagnostics.map(({ code }) => code);
}

function sampleOf<F>(surface: PlaceholderSurface<F>): F {
  const sample = surface.samples[0];
  if (!sample) throw new Error(`${surface.id} has no sample`);
  return sample.facts;
}

function createdName(h: ReturnType<typeof harness>): unknown {
  const call = h
    .calls()
    .find((entry) => entry.method === 'POST' && entry.path === `/guilds/${GUILD}/channels`);

  return (call?.body as Record<string, unknown> | undefined)?.name;
}

function contentsIn(h: ReturnType<typeof harness>, channelId: string): string[] {
  return h
    .sentIn(channelId)
    .map((body) => body.content)
    .filter((content): content is string => typeof content === 'string');
}

function countAnswerReads(h: ReturnType<typeof harness>): { count: number } {
  const counter = { count: 0 };
  const read = h.store.listAnswers.bind(h.store);

  h.store.listAnswers = async (ticketId) => {
    counter.count += 1;
    return read(ticketId);
  };

  return counter;
}

function askedNames(h: ReturnType<typeof harness>): { deps: TicketsDeps; asked: string[] } {
  const asked: string[] = [];

  return {
    asked,
    deps: {
      ...h.deps,
      displayName: async (userId) => {
        asked.push(userId);
        return (await h.deps.displayName?.(userId)) ?? null;
      },
    },
  };
}

const FORM_TYPE = ticketTypeSchema.parse({
  ...TYPE,
  transcript: 'off',
  form: [{ id: 'order', label: 'Order number', style: 'short', required: true, options: [] }],
});

describe('channel names keep the split-and-join output', () => {
  const patterns = [
    'ticket-{number}',
    '{type}-{number}-{user}',
    'ticket-{user}',
    `${'a'.repeat(200)}-{number}`,
    '!!!',
    '{nobody}-{number}',
    '{user}{user}-{number}',
    '{ user }-{number}',
    'ticket-{Number}',
  ];

  for (const [opener, typeName] of [
    ['Fraimer', 'Billing'],
    ['a!!!b   c', ''],
    [MEMBER, 'Bug Report'],
    ['_New*comer*_ `x` <@1> [a](b)', 'Spam & Eggs'],
    ['{number}', '{user} desk'],
    ['', 'x'],
  ] as const) {
    test(`byte-identical for an opener of '${opener}' and a type of '${typeName}'`, () => {
      for (const pattern of patterns) {
        const expected = legacyName(pattern, 7, opener, typeName);

        expect(renderTicketChannelName(pattern, nameFacts(opener, typeName), SAMPLE_NOW)).toBe(
          expected,
        );
        expect(renderChannelName(pattern, 7, opener, typeName)).toBe(expected);
      }
    });
  }

  test('changed: an opener named {type} is written once, where split-and-join expanded it', () => {
    const rendered = renderTicketChannelName(
      'ticket-{user}',
      nameFacts('{type}', 'Billing'),
      SAMPLE_NOW,
    );

    expect(legacyName('ticket-{user}', 7, '{type}', 'Billing')).toBe('ticket-billing');
    expect(rendered).toBe('ticket-type');
  });

  test('an opener name holding a placeholder is never expanded', () => {
    expect(
      renderTicketChannelName(
        'ticket-{user}',
        nameFacts('{ticket.subject}', 'Billing'),
        SAMPLE_NOW,
      ),
    ).toBe('ticket-ticket-subject');
  });

  test('a rendered name never passes Discord’s hundred characters', () => {
    const long = {
      ...nameFacts('x', 'Billing'),
      owner: {
        id: MEMBER,
        username: 'long',
        globalName: 'a'.repeat(300),
        avatarHash: null,
      },
    };

    expect(renderTicketChannelName('{user.global_name}{number}', long, SAMPLE_NOW)).toHaveLength(
      100,
    );
  });

  test('opening a ticket names the channel as before', async () => {
    const h = harness({
      config: { namePattern: '{type}-{number}-{user}', creationCooldown: '0s' },
    });
    await h.press(pressEvent(OPEN));

    expect(createdName(h)).toBe(legacyName('{type}-{number}-{user}', 1, 'member', 'Support'));
  });
});

describe('the opening message keeps the split-and-join output', () => {
  const templates = [
    DEFAULT_WELCOME,
    'hello {user}',
    '{user}{user} {users} {user.x}',
    '',
    'no placeholders at all',
    'Markdown **bold** @everyone {nope} a { lone } brace } for {user}',
  ];

  test('byte-identical through {user}, directly and through the dashboard wrapper', () => {
    for (const template of templates) {
      expect(renderTicketWelcome(template, facts(), SAMPLE_NOW)).toBe(
        legacyOpening(template, MEMBER),
      );
      expect(renderOpeningMessage(template, MEMBER)).toBe(legacyOpening(template, MEMBER));
    }
  });

  test('changed: a mention straddling 2000 units is dropped whole, where slice cut it in half', () => {
    const template = `${'x'.repeat(1990)}{user}`;

    expect(legacyOpening(template, MEMBER)).toBe(`${'x'.repeat(1990)}<@10000000`);
    expect(renderTicketWelcome(template, facts(), SAMPLE_NOW)).toBe('x'.repeat(1990));
  });

  test('a long render is clipped to 2000 units on a grapheme boundary', () => {
    const rendered = renderTicketWelcome(
      '{ticket.subject}'.repeat(10),
      facts({ ticket: record({ subject: FAMILY.repeat(40) }) }),
      SAMPLE_NOW,
    );

    expect(rendered).toBe(FAMILY.repeat(250));
    expect(rendered).toHaveLength(2000);
  });

  test('the welcome panel posted on open still greets the owner', async () => {
    const h = harness({ config: { creationCooldown: '0s' } });
    await h.press(pressEvent(OPEN));

    expect(JSON.stringify(h.sentIn(CREATED)[0])).toContain(legacyOpening(DEFAULT_WELCOME, MEMBER));
  });
});

describe('who {user} is', () => {
  test('after a transfer the refreshed welcome names the new owner, and the opener stays the opener', async () => {
    const type = ticketTypeSchema.parse({
      ...TYPE,
      welcomeMessage: '{user} / {user.mention} / {ticket.opener_mention}',
    });
    const h = harness({ config: { types: [type], creationCooldown: '0s' } });

    await h.press(pressEvent(OPEN));
    const ticket = h.ticket();

    expect(JSON.stringify(h.sentIn(CREATED)[0])).toContain(
      `<@${MEMBER}> / <@${MEMBER}> / <@${MEMBER}>`,
    );

    await h.run(subcommand('transfer', [userOption('user', OTHER_HELPER)]), {
      ...MOD,
      channelId: ticket.channelId,
    });
    expect(h.ticket().ownerId).toBe(OTHER_HELPER);

    await h.press(
      pressEvent(customId('claim'), { ...STAFF, channelId: ticket.channelId, eventId: newId() }),
    );

    const edit = h
      .calls()
      .filter((call) => call.method === 'PATCH' && call.path.endsWith(`/messages/${PANEL_MESSAGE}`))
      .at(-1);

    expect(JSON.stringify(edit?.body)).toContain(
      `<@${OTHER_HELPER}> / <@${OTHER_HELPER}> / <@${MEMBER}>`,
    );
  });

  test('the rename prefill keeps the owner id for {user}, and reads no name for it', async () => {
    const h = harness({ config: { namePattern: 'ticket-{user}', creationCooldown: '0s' } });
    await h.press(pressEvent(OPEN));

    const { deps, asked } = askedNames(h);

    expect(await defaultName(h.context(), h.ticket(), deps)).toBe(`ticket-${MEMBER}`);
    expect(asked).toEqual([]);
  });

  test('the canonical {user.global_name} on the rename prefill reads the real name', async () => {
    const h = harness({
      config: { namePattern: 'ticket-{user.global_name}-{number}', creationCooldown: '0s' },
    });
    await h.press(pressEvent(OPEN));

    const { deps, asked } = askedNames(h);

    expect(await defaultName(h.context(), h.ticket(), deps)).toBe('ticket-member-1');
    expect(asked).toEqual([MEMBER]);
  });
});

describe('private ticket data', () => {
  test('{ticket.subject} in a name pattern is restricted, not unknown, and blocks a changed save', () => {
    const codes = codesOn(TICKET_NAME_SURFACE, 'ticket-{number}-{ticket.subject}');

    expect(codes).toContain('restricted');
    expect(codes).not.toContain('unknown_placeholder');

    const before = ticketsConfigSchema.parse({});
    const next = { ...before, namePattern: 'ticket-{number}-{ticket.subject}' };

    expect(
      validateConfigTemplates(ticketsTemplates, next, before).blocking.map((issue) => [
        issue.path,
        issue.diagnostic.code,
      ]),
    ).toEqual([['namePattern', 'restricted']]);
    expect(validateConfigTemplates(ticketsTemplates, next, next).blocking).toEqual([]);
  });

  test('a form answer in a type’s name pattern is restricted and named in the API error', () => {
    const before = ticketsConfigSchema.parse({ types: [{ id: 'billing', name: 'Billing' }] });
    const next = {
      ...before,
      types: [{ ...before.types[0], namePattern: 'ticket-{number}-{ticket.answer.order}' }],
    };
    const report = validateConfigTemplates(ticketsTemplates, next, before);

    expect(report.blocking.map((issue) => [issue.path, issue.diagnostic.code])).toEqual([
      ['types.0.namePattern', 'restricted'],
    ]);
    expect(formatTemplateIssues(report)).toStartWith(
      'types.0.namePattern Name pattern: {ticket.answer.order} may only be shown to',
    );
  });

  test('the name surface never asks its lookup for restricted keys', () => {
    const asked: string[] = [];
    const lookup: PlaceholderLookup = (request) => {
      asked.push(request.key);
      return v.text('SECRET');
    };

    const rendered = renderTemplate('ticket-{ticket.subject}-{ticket.answer.order}', lookup, {
      registry: TICKET_NAME_SURFACE.registry,
      field: 'plain_text',
      event: TICKET_NAME_SURFACE.event,
      audience: TICKET_NAME_SURFACE.audience,
    });

    expect(asked).toEqual([]);
    expect(rendered.output).toBe('ticket--');
    expect(rendered.diagnostics.map(({ code }) => code)).toEqual(['restricted', 'restricted']);
  });

  test('facts carrying a subject and answers still cannot leak into a channel name', () => {
    const leaky = {
      ...nameFacts('Fraimer', 'Billing'),
      subject: 'SECRET',
      answers: [{ fieldId: 'order', value: 'SECRET' }],
    };

    expect(
      renderTicketChannelName(
        'ticket-{number}-{ticket.subject}-{ticket.answer.order}',
        leaky,
        SAMPLE_NOW,
      ),
    ).toBe('ticket-7');
  });

  test('opening with a restricted name pattern never reads the answers and leaks nothing', async () => {
    const h = harness({
      config: {
        types: [FORM_TYPE],
        namePattern: 'ticket-{number}-{ticket.answer.order}-{ticket.subject}',
        creationCooldown: '0s',
      },
    });
    const reads = countAnswerReads(h);

    await h.press(pressEvent(OPEN));
    await h.submit(customId('form', PANEL.id, FORM_TYPE.id), { order: 'SECRET-1182' });

    expect(h.ticket().subject).toBe('SECRET-1182');
    expect(createdName(h)).toBe('ticket-1');
    expect(reads.count).toBe(0);
  });

  test('a form answer in the closing message is unavailable, and closing never reads answers', async () => {
    expect(codesOn(TICKET_CLOSE_SURFACE, '{ticket.answer.order}')).toContain('unavailable');
    expect(ticketSourcesFor(TICKET_CLOSE_SURFACE, ['{ticket.answer.order}']).answers).toBe(false);

    const h = harness({
      config: {
        types: [FORM_TYPE],
        closeConfirmation: 'Closed {ticket.answer.order}.',
        creationCooldown: '0s',
      },
    });

    await h.press(pressEvent(OPEN));
    await h.submit(customId('form', PANEL.id, FORM_TYPE.id), { order: 'SECRET-1182' });
    const ticket = h.ticket();
    const reads = countAnswerReads(h);

    await h.run(subcommand('close'), { ...MOD, channelId: ticket.channelId });

    expect(contentsIn(h, ticket.channelId)).toContain('Closed .');
    expect(reads.count).toBe(0);
  });

  test('a form answer and a ticket number are unavailable in the blacklist message', () => {
    expect(codesOn(TICKET_BLACKLIST_SURFACE, '{ticket.answer.order}')).toContain('unavailable');
    expect(codesOn(TICKET_BLACKLIST_SURFACE, '{ticket.number}')).toContain('unavailable');
  });

  test('a subject holding markup and a placeholder renders escaped and unexpanded', () => {
    const rendered = renderTicketWelcome(
      'Subject: {ticket.subject}',
      facts({
        ticket: record({ subject: '<@&100000000000000020> {ticket.answer.x} **bold** @everyone' }),
        answers: [{ fieldId: 'x', value: 'SECRET' }],
      }),
      SAMPLE_NOW,
    );

    expect(rendered).toBe(
      `Subject: \\<@&100000000000000020\\> {ticket.answer.x} \\*\\*bold\\*\\* @${ZERO_WIDTH_SPACE}everyone`,
    );
    expect(rendered).not.toMatch(/(?<!\\)<@&/);
    expect(rendered).not.toContain('SECRET');
  });
});

describe('names that must never resolve', () => {
  const hostile =
    '{constructor} {__proto__} {toString} {ticket.constructor} {ticket.answer.toString} ' +
    '{ticket.answer.__proto__} {ticket.answer.hasOwnProperty} {user.__proto__}';

  test('post as written or render empty on every surface, never a function', () => {
    const expected =
      '{constructor} {__proto__} {toString} {ticket.constructor}  {ticket.answer.__proto__}  {user.__proto__}';

    for (const surface of [TICKET_WELCOME_SURFACE, TICKET_RESPONSE_SURFACE]) {
      expect(renderTicketText(surface, hostile, facts({ answers: [] }), SAMPLE_NOW)).toBe(expected);
    }

    for (const surface of [TICKET_CLOSE_SURFACE, TICKET_BLACKLIST_SURFACE]) {
      expect(renderTicketText(surface, hostile, facts(), SAMPLE_NOW)).not.toMatch(
        /function|native code/,
      );
    }

    expect(renderTicketChannelName(hostile, nameFacts('x', 'y'), SAMPLE_NOW)).not.toMatch(
      /function|native/,
    );
  });

  test('a stored config with __proto__ keys is read by its own keys and pollutes nothing', () => {
    const stored: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"namePattern":"{constructor}-{number}",' +
        '"types":[{"__proto__":{"namePattern":"x"},"namePattern":"{__proto__}"}],' +
        '"responses":[{"content":"{toString}"}]}',
    );

    const report = validateConfigTemplates(ticketsTemplates, stored, stored);

    expect(report.blocking).toEqual([]);
    expect([...report.byPath.keys()].sort()).toEqual([
      'namePattern',
      'responses.0.content',
      'types.0.namePattern',
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('collect never throws on a config of the wrong shape', () => {
    for (const garbage of [
      null,
      'namePattern',
      42,
      [],
      { types: 'no' },
      { responses: [null, 5, { content: 7 }] },
      { namePattern: 3, closeConfirmation: {}, blacklistMessage: [] },
    ]) {
      expect(ticketsTemplates.collect(garbage)).toEqual([]);
    }
  });
});

describe('the closing message', () => {
  test('without placeholders it is posted exactly as stored', () => {
    const plain = 'This ticket is closed. **Thanks** @everyone <#1> a { lone } brace.';

    expect(
      renderTicketText(
        TICKET_CLOSE_SURFACE,
        plain,
        facts({ close: { closedById: HELPER, reason: null } }),
        SAMPLE_NOW,
      ),
    ).toBe(plain);
  });

  test('an unknown {nope} and a legacy {user} post as written; {{ is now a literal brace', () => {
    expect(
      renderTicketText(
        TICKET_CLOSE_SURFACE,
        'Bye {user} {nope} {{literal}}',
        facts({ close: { closedById: HELPER, reason: null } }),
        SAMPLE_NOW,
      ),
    ).toBe('Bye {user} {nope} {literal}');
  });

  test('names who closed it, why, and the closer through actor', async () => {
    const h = harness({
      config: {
        types: [FORM_TYPE],
        closeConfirmation:
          'Closed by {ticket.closed_by} ({actor.global_name}) for {user.global_name}: {ticket.close_reason}',
        creationCooldown: '0s',
      },
    });

    await h.press(pressEvent(OPEN));
    await h.submit(customId('form', PANEL.id, FORM_TYPE.id), { order: '1182' });
    const ticket = h.ticket();

    await h.run(subcommand('close', [stringOption('reason', 'Sorted')]), {
      ...MOD,
      channelId: ticket.channelId,
    });

    expect(contentsIn(h, ticket.channelId)).toContain(
      `Closed by <@${HELPER}> (helper) for member: Sorted`,
    );
  });

  test('a close by Proton’s own timer names Proton’s account, never proton:tickets', async () => {
    const h = harness({
      config: {
        types: [FORM_TYPE],
        closeConfirmation:
          '{ticket.closed_by} / {actor.global_name} / {ticket.close_reason:fallback("no reason")}',
        creationCooldown: '0s',
      },
    });

    await h.press(pressEvent(OPEN));
    await h.submit(customId('form', PANEL.id, FORM_TYPE.id), { order: '1182' });
    const ticket = h.ticket();

    const closed = await closeTicket({
      ctx: h.context(),
      store: h.store,
      deps: h.deps,
      ticket,
      closedBy: PROTON_ACTOR,
      reason: null,
      idempotencyKey: 'auto-close',
    });

    expect(closed.ok).toBe(true);
    expect(contentsIn(h, ticket.channelId)).toContain(`<@${BOT}> / proton / no reason`);
  });
});

describe('the blacklist refusal', () => {
  test('fills in the member, the type, the priority and the block', async () => {
    const h = harness({
      config: {
        blacklistMessage:
          'No tickets for {user.global_name} in {ticket.type_name} ({ticket.priority}): {ticket.blacklist_reason}',
        creationCooldown: '0s',
      },
    });

    await h.store.blacklist({
      guildId: GUILD,
      userId: MEMBER,
      reason: 'spam',
      createdBy: HELPER,
      expiresAt: null,
    });
    await h.press(pressEvent(OPEN));

    expect(h.store.rows.size).toBe(0);
    expect(h.lastTold()).toContain(
      'No tickets for member in Support (Medium): spam\n\n**Reason**\nspam',
    );
  });

  test('stays within 2000 units with the reason appended whole', async () => {
    const h = harness();
    const reason = 'r'.repeat(500);

    await h.store.blacklist({
      guildId: GUILD,
      userId: MEMBER,
      reason,
      createdBy: HELPER,
      expiresAt: null,
    });

    const outcome = await mayOpen({
      ctx: h.context({ config: { blacklistMessage: '{ticket.blacklist_reason}'.repeat(19) } }),
      store: h.store,
      type: TYPE,
      openerId: MEMBER,
      now: h.now(),
      deps: h.deps,
    });

    if (outcome.ok) throw new Error('a blacklisted member was let through');
    expect(outcome.humanReason).toHaveLength(2000);
    expect(outcome.humanReason.endsWith(`\n\n**Reason**\n${reason}`)).toBe(true);
  });
});

describe('quick responses', () => {
  const responses = (content: string) => [{ id: 'hello', label: 'Hello', content }];

  test('fill in the owner, the staff member, the ticket and a form answer, reading answers once', async () => {
    const h = harness({
      config: {
        types: [FORM_TYPE],
        responses: responses(
          'Hi {user.global_name}, {actor.global_name} here about #{ticket.number}: {ticket.answer.order}. {nope}',
        ),
        creationCooldown: '0s',
      },
    });

    await h.press(pressEvent(OPEN));
    await h.submit(customId('form', PANEL.id, FORM_TYPE.id), { order: '1182' });
    const ticket = h.ticket();
    const reads = countAnswerReads(h);

    await h.run(subcommand('response', [stringOption('name', 'hello')]), {
      ...STAFF,
      channelId: ticket.channelId,
    });

    expect(contentsIn(h, ticket.channelId)).toContain(
      'Hi member, helper here about #1: 1182. {nope}',
    );
    expect(reads.count).toBe(1);
  });

  test('without placeholders they post exactly as saved and read nothing', async () => {
    const saved = 'Plain reply with **markdown**, @here and a {brace}.';
    const h = harness({ config: { responses: responses(saved), creationCooldown: '0s' } });

    await h.press(pressEvent(OPEN));
    const ticket = h.ticket();
    const reads = countAnswerReads(h);
    const { deps, asked } = askedNames(h);

    await h.run(subcommand('response', [stringOption('name', 'hello')]), {
      ...STAFF,
      channelId: ticket.channelId,
      deps,
    });

    expect(contentsIn(h, ticket.channelId)).toContain(saved);
    expect(reads.count).toBe(0);
    expect(asked).toEqual([]);
  });

  test('read the server, Proton and the owner through the environment only when used', async () => {
    const calls: string[] = [];
    const placeholders: PlaceholderEnvironment = {
      applicationId: BOT,
      bot: async () => {
        calls.push('bot');
        return { id: BOT, name: 'Proton', avatarHash: null, supportUrl: 'https://discord.gg/x' };
      },
      server: async (guildId) => {
        calls.push(`server:${guildId}`);
        return { id: guildId, name: 'Proton HQ' };
      },
      user: async (userId) => {
        calls.push(`user:${userId}`);
        return {
          id: userId,
          username: `name-${userId.slice(-1)}`,
          globalName: null,
          avatarHash: null,
        };
      },
      now: () => SAMPLE_NOW,
    };

    const h = harness({
      config: {
        responses: responses('{server.name} / {bot.name} / {user.username} / {ticket.number}'),
        creationCooldown: '0s',
      },
    });

    await h.press(pressEvent(OPEN));
    const ticket = h.ticket();

    await h.run(subcommand('response', [stringOption('name', 'hello')]), {
      ...STAFF,
      channelId: ticket.channelId,
      deps: { ...h.deps, placeholders },
    });

    expect(contentsIn(h, ticket.channelId)).toContain('Proton HQ / Proton / name-1 / 1');
    expect(calls.sort()).toEqual(['bot', `server:${GUILD}`, `user:${MEMBER}`]);
  });

  test('a server read that throws still posts, with the value empty and a warning logged', async () => {
    const placeholders: PlaceholderEnvironment = {
      applicationId: BOT,
      bot: async () => ({ id: BOT, supportUrl: 'https://discord.gg/x' }),
      server: async () => {
        throw new Error('redis is down');
      },
      user: async () => null,
      now: () => SAMPLE_NOW,
    };

    const h = harness({
      config: { responses: responses('Welcome to {server.name}!'), creationCooldown: '0s' },
    });

    await h.press(pressEvent(OPEN));
    const ticket = h.ticket();

    await h.run(subcommand('response', [stringOption('name', 'hello')]), {
      ...STAFF,
      channelId: ticket.channelId,
      deps: { ...h.deps, placeholders },
    });

    const warned = h.logs.some(
      (log) => log.level === 'warn' && log.message.includes('redis is down'),
    );

    expect(contentsIn(h, ticket.channelId)).toContain('Welcome to !');
    expect(warned).toBe(true);
  });

  test('a long render is clipped to 2000 units', () => {
    const rendered = renderTicketText(
      TICKET_RESPONSE_SURFACE,
      '{ticket.subject}'.repeat(40),
      facts({ ticket: record({ subject: 's'.repeat(300) }) }),
      SAMPLE_NOW,
    );

    expect(rendered).toHaveLength(2000);
  });
});

describe('the surfaces', () => {
  test('the manifest declares the tickets templates, and each surface is registered', () => {
    expect(createTicketsModule().templates).toBe(ticketsTemplates);
    expect(Object.keys(ticketsTemplates.surfaces).sort()).toEqual([
      'tickets.blacklist',
      'tickets.channel_name',
      'tickets.close',
      'tickets.response',
      'tickets.welcome',
    ]);
  });

  test('collect finds every template in a config', () => {
    const config = ticketsConfigSchema.parse({
      types: [{ id: 'billing', name: 'Billing', namePattern: 'bill-{number}' }],
      responses: [{ id: 'hi', label: 'Hi', content: 'Hello' }],
    });

    const sites = ticketsTemplates.collect(config).map((site) => [site.surfaceId, site.path]);

    expect(sites.sort()).toEqual([
      ['tickets.blacklist', 'blacklistMessage'],
      ['tickets.channel_name', 'namePattern'],
      ['tickets.channel_name', 'types.0.namePattern'],
      ['tickets.close', 'closeConfirmation'],
      ['tickets.response', 'responses.0.content'],
      ['tickets.welcome', 'types.0.welcomeMessage'],
    ]);
  });

  test('only the channel name and the opening message carry legacy names', () => {
    expect(TICKET_NAME_SURFACE.registry.resolve('number')?.canonical).toBe('ticket.number');
    expect(TICKET_NAME_SURFACE.registry.resolve('type')?.canonical).toBe('ticket.type_name');
    expect(TICKET_NAME_SURFACE.registry.resolve('user')?.canonical).toBe('user.global_name');
    expect(TICKET_WELCOME_SURFACE.registry.resolve('user')?.canonical).toBe('user.mention');
    expect(TICKET_WELCOME_SURFACE.registry.resolve('number')).toBeUndefined();

    const verbatim = [TICKET_CLOSE_SURFACE, TICKET_BLACKLIST_SURFACE, TICKET_RESPONSE_SURFACE];

    for (const surface of verbatim) {
      expect(surface.registry.resolve('user')).toBeUndefined();
    }
  });

  test('the pickers offer what each message can show', () => {
    const keys = (surface: PlaceholderSurface<unknown>, path: string) =>
      surface.pickerFor(path).map(({ key }) => key);

    const name = keys(TICKET_NAME_SURFACE, 'namePattern');
    expect(name).toEqual(
      expect.arrayContaining(['ticket.number', 'user.global_name', 'server.name']),
    );
    expect(name).not.toContain('ticket.subject');
    expect(name).not.toContain('ticket.answer.<question_key>');
    expect(name).not.toContain('ticket.priority');
    expect(name).not.toContain('bot.name');
    expect(keys(TICKET_NAME_SURFACE, 'types.3.namePattern')).toEqual(name);

    const welcome = keys(TICKET_WELCOME_SURFACE, 'types.0.welcomeMessage');
    expect(welcome).toEqual(
      expect.arrayContaining([
        'ticket.answer.<question_key>',
        'ticket.participant_count',
        'ticket.subject',
      ]),
    );
    expect(welcome).not.toContain('ticket.closed_by');

    const close = keys(TICKET_CLOSE_SURFACE, 'closeConfirmation');
    expect(close).toEqual(
      expect.arrayContaining(['ticket.closed_by', 'ticket.close_reason', 'actor.global_name']),
    );
    expect(close).not.toContain('ticket.answer.<question_key>');

    const blacklist = keys(TICKET_BLACKLIST_SURFACE, 'blacklistMessage');
    expect(blacklist).toEqual(
      expect.arrayContaining([
        'ticket.blacklist_reason',
        'ticket.blacklist_expires_at',
        'ticket.priority',
      ]),
    );
    expect(blacklist).not.toContain('ticket.number');
    expect(blacklist).not.toContain('ticket.answer.<question_key>');

    const response = keys(TICKET_RESPONSE_SURFACE, 'responses.2.content');
    expect(response).toEqual(
      expect.arrayContaining(['actor.global_name', 'ticket.answer.<question_key>']),
    );
  });

  test('the samples render the shipped defaults and their captions', () => {
    const name = renderTicketChannelName(
      'ticket-{number}',
      sampleOf(TICKET_NAME_SURFACE),
      SAMPLE_NOW,
    );
    const welcome = renderTicketWelcome(
      DEFAULT_WELCOME,
      sampleOf(TICKET_WELCOME_SURFACE),
      SAMPLE_NOW,
    );
    const closed = renderTicketText(
      TICKET_CLOSE_SURFACE,
      '{ticket.closed_by} closed #{ticket.number} ({ticket.close_reason})',
      sampleOf(TICKET_CLOSE_SURFACE),
      SAMPLE_NOW,
    );
    const answered = renderTicketText(
      TICKET_RESPONSE_SURFACE,
      '{actor.global_name} answering {user.global_name}',
      sampleOf(TICKET_RESPONSE_SURFACE),
      SAMPLE_NOW,
    );

    expect(name).toBe('ticket-42');
    expect(welcome).toBe(
      'Thanks for getting in touch, <@100000000000000010>. Describe the problem below.',
    );
    expect(TICKET_WELCOME_SURFACE.samples[0]?.label).toBe(
      'Sample: Fraimer opening Billing ticket #42 in Proton HQ',
    );
    expect(closed).toBe('<@100000000000000030> closed #42 (Refund issued)');
    expect(answered).toBe('Helper answering Fraimer');
  });

  test('every picker key renders from its sample, with none absent but the ones not set', () => {
    const cases = [
      [TICKET_NAME_SURFACE, 'namePattern'],
      [TICKET_WELCOME_SURFACE, 'types.0.welcomeMessage'],
      [TICKET_CLOSE_SURFACE, 'closeConfirmation'],
      [TICKET_BLACKLIST_SURFACE, 'blacklistMessage'],
      [TICKET_RESPONSE_SURFACE, 'responses.0.content'],
    ] as const;

    for (const [surface, path] of cases) {
      const general: PlaceholderSurface<unknown> = surface;
      const lookup = general.build(sampleOf(general), { now: SAMPLE_NOW });

      for (const { key } of surface.pickerFor(path)) {
        if (key.includes('<')) continue;

        const rendered = renderTemplate(`{${key}}`, lookup, {
          registry: surface.registry,
          field: surface.fields[0]?.kind ?? 'plain_text',
          event: surface.event,
          audience: surface.audience,
          now: SAMPLE_NOW,
        });
        const absent = rendered.diagnostics.filter(({ code }) => code !== 'not_set');

        expect([surface.id, key, absent]).toEqual([surface.id, key, []]);
      }
    }
  });

  test('loads only the sources a template uses', () => {
    const legacy = ticketSourcesFor(TICKET_NAME_SURFACE, ['ticket-{user}-{number}-{type}']);
    const named = ticketSourcesFor(TICKET_NAME_SURFACE, ['{ticket.subject} {server.name}']);
    const replying = ticketSourcesFor(TICKET_RESPONSE_SURFACE, [
      '{actor.username} {bot.name} {ticket.answer.order} {ticket.participant_count}',
    ]);

    expect(legacy).toEqual({
      owner: false,
      actor: false,
      server: false,
      bot: false,
      answers: false,
      participants: false,
    });
    expect(ticketSourcesFor(TICKET_NAME_SURFACE, ['{user.mention}']).owner).toBe(true);
    expect(ticketSourcesFor(TICKET_WELCOME_SURFACE, ['{user} {user.mention}']).owner).toBe(false);
    expect(named).toMatchObject({ server: true, answers: false });
    expect(replying).toEqual({
      owner: false,
      actor: true,
      server: false,
      bot: true,
      answers: true,
      participants: true,
    });
  });
});

describe('the name pattern check', () => {
  test('accepts a canonical number or member key, and a stored {{number}} still parses', () => {
    for (const namePattern of [
      'ticket-{ticket.number}',
      '{user.global_name}',
      'ticket-{user.id}',
      '{user.username}-help',
      '{{number}}',
      'ticket-{number}',
      '{user}',
    ]) {
      expect(ticketsConfigSchema.safeParse({ namePattern }).success).toBe(true);
    }
  });

  test('accepts every name placeholder the picker offers that tells one ticket from another', () => {
    const notNames = ['user.avatar_url', 'user.is_bot', 'user.created_at', 'user.account_age'];
    const offered = TICKET_NAME_SURFACE.pickerFor('namePattern').map(({ key }) => key);
    const naming = offered.filter(
      (key) => key === 'ticket.number' || (key.startsWith('user.') && !notNames.includes(key)),
    );
    const accepted = (key: string) =>
      ticketsConfigSchema.safeParse({ namePattern: `ticket-{${key}}` }).success;

    expect(naming).toEqual(expect.arrayContaining(['user.display_name', 'user.mention']));
    expect(offered).toEqual(expect.arrayContaining(notNames));
    expect(naming.filter((key) => !accepted(key))).toEqual([]);
    expect(notNames.filter(accepted)).toEqual([]);
  });

  test('still refuses a pattern every ticket would share', () => {
    for (const namePattern of ['ticket-{type}', '{server.name}', 'support', '{ticket.subject}']) {
      expect(ticketsConfigSchema.safeParse({ namePattern }).success).toBe(false);
    }
  });
});
