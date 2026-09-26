import { describe, expect, test } from 'bun:test';
import {
  encodeCustomId,
  type RawOption,
  STATUS_ERROR_EMOJI,
  STATUS_SUCCESS_EMOJI,
} from '@proton/core';
import { renderOpenList } from '../src/commands.ts';
import { ticketResponseSchema } from '../src/config.ts';
import type { TicketsDeps } from '../src/deps.ts';
import { createTicketsModule } from '../src/index.ts';
import { describePriority } from '../src/interface.ts';
import {
  ADMIN,
  ARCHIVE_CATEGORY,
  BOT,
  CREATED,
  channelOption,
  GUILD,
  group,
  type Harness,
  HELPER,
  harness,
  INTERACTION,
  integerOption,
  MEMBER,
  MOD,
  OTHER_HELPER,
  OTHER_STAFF,
  type Overrides,
  PANEL,
  PANEL_CHANNEL,
  pressEvent,
  STAFF,
  stringOption,
  subcommand,
  TYPE,
  userOption,
} from './harness.ts';

const EPHEMERAL = 64;
const COMPONENTS_V2 = 32768;
const REPLY = 4;
const DEFERRED = 5;

const S = STATUS_SUCCESS_EMOJI;
const E = STATUS_ERROR_EMOJI;

const PASSER_BY = '100000000000000099';
const OTHER_APPLICATION = '300000000000000009';

const OPEN_PRESS = encodeCustomId('tickets', 'ot', PANEL.id, TYPE.id);
const OPEN = OPEN_PRESS.ok ? OPEN_PRESS.customId : '';

const HELLO = ticketResponseSchema.parse({ id: 'hello', label: 'Hello', content: 'Hi there.' });

const REFUSED = { status: 403, body: { message: 'Missing Permissions', code: 50013 } };
const UNAVAILABLE = { status: 503, body: { message: 'Service Unavailable' } };

const CREATE = subcommand('create', [stringOption('type', TYPE.id)]);

interface Case {
  name: string;
  options: RawOption[];
  as?: Partial<Overrides>;
  unopened?: boolean;
  arrange?: (h: Harness) => Promise<void>;
  says: string | ((h: Harness) => string);
  partial?: boolean;
}

function fresh(): Harness {
  return harness({ config: { creationCooldown: '0s', responses: [HELLO] } });
}

async function arranged(c: Pick<Case, 'unopened' | 'arrange'>): Promise<Harness> {
  const h = fresh();
  if (!c.unopened) await h.press(pressEvent(OPEN));
  await c.arrange?.(h);

  h.rest.calls.splice(0);
  return h;
}

function watchedDeps(h: Harness, early: string[]): TicketsDeps {
  const acknowledged = (): boolean =>
    h.rest.calls.some((call) => call.path.startsWith('/interactions/'));

  const watch = <T extends object>(name: string, target: T): T =>
    new Proxy(target, {
      get(object, key) {
        const value: unknown = Reflect.get(object, key);
        if (typeof value !== 'function' || key === 'now') return value;

        return (...args: unknown[]) => {
          if (!acknowledged()) early.push(`${name}.${String(key)}`);
          return value.apply(object, args);
        };
      },
    });

  return watch('deps', {
    ...h.deps,
    store: watch('store', h.store),
    ...(h.deps.guildState ? { guildState: watch('guildState', h.deps.guildState) } : {}),
  });
}

function withoutApplication(h: Harness): Partial<Overrides> {
  const { applicationId: _unbound, ...deps } = h.deps;
  return { deps };
}

function expectText(h: Harness, c: Case, text: string | null): void {
  const expected = typeof c.says === 'function' ? c.says(h) : c.says;

  if (c.partial) expect(text).toContain(expected);
  else expect(text).toBe(expected);
}

function expectDeferredOnce(h: Harness): void {
  const first = h.rest.calls[0];
  expect(first?.method).toBe('POST');
  expect(first?.path).toBe(`/interactions/${INTERACTION}/interaction-token/callback`);
  expect((first?.body as { type?: number } | undefined)?.type).toBe(DEFERRED);

  const initial = h.initialCallbacks();

  expect(initial).toHaveLength(1);
  expect(initial[0]?.type).toBe(DEFERRED);
  expect(Number(initial[0]?.data.flags ?? 0) & EPHEMERAL).toBe(EPHEMERAL);
  expect(h.callbackTypes()).toEqual([DEFERRED]);
}

const cases: Case[] = [
  {
    name: 'a panel that posts',
    options: subcommand('panel', [stringOption('panel', PANEL.id)]),
    as: { ...ADMIN, channelId: PANEL_CHANNEL },
    unopened: true,
    says: `${S} Posted the **${PANEL.name}** panel in <#${PANEL_CHANNEL}>.`,
  },
  {
    name: 'a panel a passer-by may not post',
    options: subcommand('panel', [stringOption('panel', PANEL.id)]),
    as: { userId: MEMBER, channelId: PANEL_CHANNEL },
    unopened: true,
    says: `${E} You need Manage Server or Manage Channels to do that.`,
  },
  {
    name: 'a panel nobody configured',
    options: subcommand('panel', [stringOption('panel', 'nope')]),
    as: { ...ADMIN, channelId: PANEL_CHANNEL },
    unopened: true,
    says: `${E} Couldn’t find a panel called **nope**. Panels here: \`${PANEL.id}\`.`,
  },
  {
    name: 'a panel Discord refuses to post',
    options: subcommand('panel', [stringOption('panel', PANEL.id)]),
    as: { ...ADMIN, channelId: PANEL_CHANNEL },
    unopened: true,
    arrange: async (h) => h.rest.fail(`/channels/${PANEL_CHANNEL}/messages`, REFUSED),
    says: `${E} I couldn't post the **${PANEL.name}** panel in <#${PANEL_CHANNEL}>:`,
    partial: true,
  },
  {
    name: 'a create that opens a ticket',
    options: CREATE,
    as: { userId: MEMBER, channelId: PANEL_CHANNEL },
    unopened: true,
    says: `${S} Opened ticket #1 in <#${CREATED}>.`,
  },
  {
    name: 'a create for a type nobody configured',
    options: subcommand('create', [stringOption('type', 'nope')]),
    as: { userId: MEMBER, channelId: PANEL_CHANNEL },
    unopened: true,
    says: `${E} Couldn’t find a ticket type called **nope**. Ticket types here: \`${TYPE.id}\`.`,
  },
  {
    name: 'a create by a blacklisted member',
    options: CREATE,
    as: { userId: MEMBER, channelId: PANEL_CHANNEL },
    unopened: true,
    arrange: async (h) => {
      await h.store.blacklist({
        guildId: GUILD,
        userId: MEMBER,
        reason: null,
        createdBy: HELPER,
        expiresAt: null,
      });
    },
    says: (h) => h.context().config.blacklistMessage,
    partial: true,
  },
  {
    name: 'a close that happens',
    options: subcommand('close'),
    as: MOD,
    says: `${S} Closed ticket #1.`,
  },
  {
    name: 'a close outside any ticket',
    options: subcommand('close'),
    as: { ...MOD, channelId: PANEL_CHANNEL },
    says: `${E} Run this in a ticket channel, or give a ticket number with \`number:\`.`,
  },
  {
    name: 'a close of a number that does not exist',
    options: subcommand('close', [integerOption('number', 99)]),
    as: { ...MOD, channelId: PANEL_CHANNEL },
    says: `${E} Couldn’t find ticket #99. \`/ticket list\` shows the open ones.`,
  },
  {
    name: 'a close by a passer-by',
    options: subcommand('close'),
    as: { userId: PASSER_BY },
    says: `${E} You can’t do that to ticket #1.`,
    partial: true,
  },
  {
    name: 'a close that finishes an earlier close',
    options: subcommand('close'),
    as: MOD,
    arrange: async (h) => h.run(subcommand('close'), { ...MOD, channelId: CREATED }),
    says: `${S} Ticket #1 was already closed, so I finished the steps that hadn’t run yet.`,
  },
  {
    name: 'a close of a ticket that changed underneath it',
    options: subcommand('close'),
    as: MOD,
    arrange: async (h) => {
      h.store.close = async () => null;
    },
    says:
      `${E} Ticket #1 can’t be closed right now, so nothing was changed. It may have just been ` +
      'reopened or deleted.',
  },
  {
    name: 'a reopen that happens',
    options: subcommand('reopen'),
    as: MOD,
    arrange: async (h) => h.run(subcommand('close'), { ...MOD, channelId: CREATED }),
    says: `${S} Reopened ticket #1.`,
  },
  {
    name: 'a reopen of an open ticket',
    options: subcommand('reopen'),
    as: MOD,
    says: `${E} Ticket #1 isn’t closed, so there’s nothing to reopen.`,
  },
  {
    name: 'a reopen by a passer-by',
    options: subcommand('reopen'),
    as: { userId: PASSER_BY },
    arrange: async (h) => h.run(subcommand('close'), { ...MOD, channelId: CREATED }),
    says: `${E} You can’t do that to ticket #1.`,
    partial: true,
  },
  {
    name: 'a delete that happens',
    options: subcommand('delete'),
    as: ADMIN,
    says: `${S} Deleted ticket #1 and its channel.`,
  },
  {
    name: 'a delete support staff may not do',
    options: subcommand('delete'),
    as: STAFF,
    says: `${E} You can’t do that to ticket #1.`,
    partial: true,
  },
  {
    name: 'a delete of a ticket deleted underneath it',
    options: subcommand('delete'),
    as: ADMIN,
    arrange: async (h) => {
      h.store.markDeleted = async () => null;
    },
    says: `${E} Ticket #1 was already deleted, so nothing was changed.`,
  },
  {
    name: 'a claim',
    options: subcommand('claim'),
    as: STAFF,
    says: `${S} You claimed ticket #1.`,
  },
  {
    name: 'a claim somebody else made first',
    options: subcommand('claim'),
    as: STAFF,
    arrange: async (h) => h.run(subcommand('claim'), { ...OTHER_STAFF, channelId: CREATED }),
    says: `${E} <@${OTHER_HELPER}> claimed this ticket first.`,
  },
  {
    name: 'a claim of a closed ticket',
    options: subcommand('claim'),
    as: STAFF,
    arrange: async (h) => h.run(subcommand('close'), { ...MOD, channelId: CREATED }),
    says: `${E} Ticket #1 can’t be claimed because it’s no longer open.`,
  },
  {
    name: 'an unclaim',
    options: subcommand('unclaim'),
    as: STAFF,
    arrange: async (h) => h.run(subcommand('claim'), { ...STAFF, channelId: CREATED }),
    says: `${S} Ticket #1 is unclaimed and back in the queue.`,
  },
  {
    name: 'an unclaim of an unclaimed ticket',
    options: subcommand('unclaim'),
    as: MOD,
    says: `${E} This ticket isn’t claimed.`,
  },
  {
    name: 'an assign',
    options: subcommand('assign', [userOption('user', HELPER)]),
    as: STAFF,
    says: `${S} Ticket #1 is assigned to <@${HELPER}>.`,
  },
  {
    name: 'an assign by the member who raised it',
    options: subcommand('assign', [userOption('user', HELPER)]),
    as: { userId: MEMBER },
    says: `${E} You can’t do that to ticket #1.`,
    partial: true,
  },
  {
    name: 'a transfer',
    options: subcommand('transfer', [userOption('user', HELPER)]),
    as: STAFF,
    says: `${S} <@${HELPER}> now owns ticket #1.`,
  },
  {
    name: 'a transfer to the owner',
    options: subcommand('transfer', [userOption('user', MEMBER)]),
    as: STAFF,
    says: `${E} <@${MEMBER}> already owns ticket #1.`,
  },
  {
    name: 'an add',
    options: subcommand('add', [userOption('user', OTHER_HELPER)]),
    as: STAFF,
    says: `${S} Added <@${OTHER_HELPER}> to ticket #1.`,
  },
  {
    name: 'an add naming nobody',
    options: subcommand('add'),
    as: STAFF,
    says: `${E} Choose a member for this command.`,
  },
  {
    name: 'a remove',
    options: subcommand('remove', [userOption('user', OTHER_HELPER)]),
    as: STAFF,
    arrange: async (h) =>
      h.run(subcommand('add', [userOption('user', OTHER_HELPER)]), {
        ...STAFF,
        channelId: CREATED,
      }),
    says: `${S} Removed <@${OTHER_HELPER}> from ticket #1.`,
  },
  {
    name: 'a remove of somebody nobody added',
    options: subcommand('remove', [userOption('user', OTHER_HELPER)]),
    as: STAFF,
    says:
      `${E} <@${OTHER_HELPER}> wasn’t added to this ticket, so there’s nothing to remove. If ` +
      'they can see it through a staff role, change their roles instead.',
  },
  {
    name: 'a remove of the owner',
    options: subcommand('remove', [userOption('user', MEMBER)]),
    as: STAFF,
    says:
      `${E} That member owns this ticket, so they can’t be removed from it. Close the ticket, or ` +
      'transfer it to someone else first.',
  },
  {
    name: 'a remove by the member who raised it',
    options: subcommand('remove', [userOption('user', OTHER_HELPER)]),
    as: { userId: MEMBER },
    says: `${E} You can’t do that to ticket #1.`,
    partial: true,
  },
  {
    name: 'a rename',
    options: subcommand('rename', [stringOption('name', 'Billing help')]),
    as: STAFF,
    says: `${S} Renamed to **#billing-help**.`,
  },
  {
    name: 'a rename by the member who raised it',
    options: subcommand('rename', [stringOption('name', 'Billing help')]),
    as: { userId: MEMBER },
    says: `${E} You can’t do that to ticket #1.`,
    partial: true,
  },
  {
    name: 'a rename Discord refuses',
    options: subcommand('rename', [stringOption('name', 'Billing help')]),
    as: STAFF,
    arrange: async (h) =>
      h.rest.fail(
        (call) => call.method === 'PATCH' && call.path === `/channels/${CREATED}`,
        REFUSED,
      ),
    says: `${E} I couldn't rename it:`,
    partial: true,
  },
  {
    name: 'a move',
    options: subcommand('move', [channelOption('category', ARCHIVE_CATEGORY)]),
    as: STAFF,
    says: `${S} Moved ticket #1.`,
  },
  {
    name: 'a move Discord refuses',
    options: subcommand('move', [channelOption('category', ARCHIVE_CATEGORY)]),
    as: STAFF,
    arrange: async (h) =>
      h.rest.fail(
        (call) => call.method === 'PATCH' && call.path === `/channels/${CREATED}`,
        REFUSED,
      ),
    says: `${E} I couldn't move it:`,
    partial: true,
  },
  {
    name: 'a priority change',
    options: subcommand('priority', [stringOption('level', 'high')]),
    as: STAFF,
    says: `${S} Ticket #1 is now ${describePriority('high')} priority.`,
  },
  {
    name: 'a priority change by the member who raised it',
    options: subcommand('priority', [stringOption('level', 'high')]),
    as: { userId: MEMBER },
    says: `${E} You can’t do that to ticket #1.`,
    partial: true,
  },
  {
    name: 'a priority nobody knows',
    options: subcommand('priority', [stringOption('level', 'whenever')]),
    as: STAFF,
    says: `${E} **whenever** isn’t a priority I know. Choose Low, Medium, High or Urgent.`,
  },
  {
    name: 'a lock',
    options: subcommand('lock'),
    as: STAFF,
    says: `${S} Ticket #1 is locked. Only staff can post in it now.`,
  },
  {
    name: 'a lock of a locked ticket',
    options: subcommand('lock'),
    as: STAFF,
    arrange: async (h) => h.run(subcommand('lock'), { ...STAFF, channelId: CREATED }),
    says: `${E} Ticket #1 is already locked or isn’t open.`,
  },
  {
    name: 'an unlock',
    options: subcommand('unlock'),
    as: STAFF,
    arrange: async (h) => h.run(subcommand('lock'), { ...STAFF, channelId: CREATED }),
    says: `${S} Ticket #1 is unlocked.`,
  },
  {
    name: 'an unlock of an unlocked ticket',
    options: subcommand('unlock'),
    as: STAFF,
    says: `${E} Ticket #1 isn’t locked.`,
  },
  {
    name: 'a transcript',
    options: subcommand('transcript'),
    as: { userId: MEMBER },
    says: `${S} Here’s the transcript of ticket #1.`,
  },
  {
    name: 'a transcript a passer-by may not have',
    options: subcommand('transcript'),
    as: { userId: PASSER_BY },
    says: `${E} You can’t do that to ticket #1.`,
    partial: true,
  },
  {
    name: 'an info a passer-by may not read',
    options: subcommand('info'),
    as: { userId: PASSER_BY },
    says: `${E} You can’t do that to ticket #1.`,
    partial: true,
  },
  {
    name: 'a list',
    options: subcommand('list'),
    as: { userId: MEMBER, channelId: PANEL_CHANNEL },
    says: (h) => renderOpenList([h.ticket()], false),
  },
  {
    name: 'a list with nothing open',
    options: subcommand('list'),
    as: { ...STAFF, channelId: PANEL_CHANNEL },
    unopened: true,
    says: 'No tickets are open right now.',
  },
  {
    name: 'a saved response',
    options: subcommand('response', [stringOption('name', HELLO.id)]),
    as: STAFF,
    says: `${S} Posted **${HELLO.label}** in <#${CREATED}>.`,
  },
  {
    name: 'a saved response nobody saved',
    options: subcommand('response', [stringOption('name', 'nope')]),
    as: STAFF,
    says: `${E} Couldn’t find a quick response called **nope**. Quick responses here: \`${HELLO.id}\`.`,
  },
  {
    name: 'a saved response Discord refuses to post',
    options: subcommand('response', [stringOption('name', HELLO.id)]),
    as: STAFF,
    arrange: async (h) => h.rest.fail(`/channels/${CREATED}/messages`, REFUSED),
    says: `${E} I couldn't post **${HELLO.label}** in <#${CREATED}>:`,
    partial: true,
  },
  {
    name: 'a saved response from the member who raised it',
    options: subcommand('response', [stringOption('name', HELLO.id)]),
    as: { userId: MEMBER },
    says: `${E} You can’t do that to ticket #1.`,
    partial: true,
  },
  {
    name: 'the stats',
    options: subcommand('stats'),
    as: ADMIN,
    says: '**Tickets in the last 30 days**\nOpened: ',
    partial: true,
  },
  {
    name: 'the stats a passer-by may not read',
    options: subcommand('stats'),
    as: { userId: PASSER_BY },
    says: `${E} You need Manage Server, Manage Channels or a staff role to do that.`,
  },
  {
    name: 'a blacklist add',
    options: group('blacklist', 'add', [userOption('user', OTHER_HELPER)]),
    as: ADMIN,
    says: `${S} <@${OTHER_HELPER}> can’t open tickets. Their open tickets stay open.`,
  },
  {
    name: 'a blacklist add with a duration that is not one',
    options: group('blacklist', 'add', [
      userOption('user', OTHER_HELPER),
      stringOption('duration', 'soon'),
    ]),
    as: ADMIN,
    says: `${E} **soon** isn’t a duration I can read. Try \`7d\`, \`12h\` or \`30m\`.`,
  },
  {
    name: 'a blacklist remove',
    options: group('blacklist', 'remove', [userOption('user', OTHER_HELPER)]),
    as: ADMIN,
    arrange: async (h) =>
      h.run(group('blacklist', 'add', [userOption('user', OTHER_HELPER)]), {
        ...ADMIN,
        channelId: CREATED,
      }),
    says: `${S} <@${OTHER_HELPER}> can open tickets again.`,
  },
  {
    name: 'a blacklist remove of somebody not blocked',
    options: group('blacklist', 'remove', [userOption('user', OTHER_HELPER)]),
    as: ADMIN,
    says: `${E} <@${OTHER_HELPER}> isn’t blocked from opening tickets.`,
  },
  {
    name: 'a blacklist list',
    options: group('blacklist', 'list'),
    as: ADMIN,
    arrange: async (h) =>
      h.run(group('blacklist', 'add', [userOption('user', OTHER_HELPER)]), {
        ...ADMIN,
        channelId: CREATED,
      }),
    says: `**1 member blocked**\n<@${OTHER_HELPER}> (permanent)`,
  },
  {
    name: 'a blacklist by a passer-by',
    options: group('blacklist', 'list'),
    as: { userId: PASSER_BY },
    says: `${E} You need Manage Server or Manage Channels to do that.`,
  },
  {
    name: 'a subcommand nobody knows',
    options: subcommand('dance'),
    as: STAFF,
    says: `${E} I don’t recognise that \`/ticket\` subcommand.`,
  },
];

describe('/ticket acknowledges each interaction exactly once', () => {
  for (const c of cases) {
    test(`${c.name}: one private defer, then the answer as one private followup`, async () => {
      const h = await arranged(c);
      const early: string[] = [];

      await h.run(c.options, { channelId: CREATED, ...c.as, deps: watchedDeps(h, early) });

      expect(early).toEqual([]);
      expectDeferredOnce(h);

      const followups = h.followUpBodies();
      expect(followups).toHaveLength(1);
      expect(followups[0]?.path).toBe(`/webhooks/${BOT}/interaction-token`);
      expect(followups[0]?.body.flags).toBe(EPHEMERAL);
      expect(followups[0]?.body.allowed_mentions).toEqual({ parse: [] });

      expectText(h, c, h.followUpContent());
    });
  }

  test('a transcript arrives as a private followup with the HTML file attached', async () => {
    const h = await arranged({});
    await h.run(subcommand('transcript'), { userId: MEMBER, channelId: CREATED });

    expectDeferredOnce(h);

    const followups = h.followUpBodies();
    expect(followups).toHaveLength(1);
    expect(followups[0]?.body.flags).toBe(EPHEMERAL);
    expect(followups[0]?.files).toHaveLength(1);
    expect(followups[0]?.files[0]).toMatchObject({ contentType: 'text/html' });
    expect(String(followups[0]?.files[0]?.filename)).toEndWith('.html');
  });

  test('an info keeps its components-v2 flag and its privacy on the followup', async () => {
    const h = await arranged({});
    await h.run(subcommand('info'), { userId: MEMBER, channelId: CREATED });

    expectDeferredOnce(h);

    const followups = h.followUpBodies();
    expect(followups).toHaveLength(1);
    expect(followups[0]?.body.flags).toBe(COMPONENTS_V2 | EPHEMERAL);
    expect(followups[0]?.body.content).toBeUndefined();
    expect(followups[0]?.body.components).toBeArray();
    expect((followups[0]?.body.components ?? []) as unknown[]).not.toHaveLength(0);
  });

  test('an info Discord refuses falls back to a second followup under its own key', async () => {
    const h = await arranged({
      arrange: async (fake) =>
        fake.rest.fail(
          (call) =>
            call.path.startsWith('/webhooks/') &&
            (Number((call.body as { flags?: number } | undefined)?.flags ?? 0) & COMPONENTS_V2) !==
              0,
          { status: 400, body: { message: 'Invalid Form Body', code: 50035 } },
        ),
    });

    await h.run(subcommand('info'), { userId: MEMBER, channelId: CREATED });

    expectDeferredOnce(h);

    const followups = h.followUpBodies();
    expect(followups).toHaveLength(2);
    expect(followups[1]?.body.flags).toBe(EPHEMERAL);
    expect(h.followUpContent()).toStartWith(`${E} I couldn't show ticket #1:`);
  });

  test('a /ticket that cannot bind its store still answers once, after its defer', async () => {
    const h = await arranged({ unopened: true });
    const { store: _unbound, ...deps } = h.deps;

    await h.run(subcommand('list'), { ...STAFF, deps });

    expectDeferredOnce(h);
    expect(h.followUpBodies()).toHaveLength(1);
    expect(h.followUpContent()).toBe(
      `${E} I can’t reach this server’s tickets right now. Nothing was changed. This is a fault ` +
        'on my side, not a setting in this server.',
    );
    expect(h.logs.some((entry) => entry.level === 'error')).toBe(true);
  });

  test('a redelivered /ticket reuses its keys, so a path that changed outcome answers nothing new', async () => {
    const h = await arranged({});

    await h.run(subcommand('claim'), { ...STAFF, channelId: CREATED, idempotencyKey: 'evt-1' });
    await h.run(subcommand('claim'), { ...STAFF, channelId: CREATED, idempotencyKey: 'evt-1' });

    expect(h.callbackTypes()).toEqual([DEFERRED]);
    expect(h.followUpBodies()).toHaveLength(1);
    expect(h.followUpContent()).toBe(`${S} You claimed ticket #1.`);
  });

  test('a redelivered /ticket create opens nothing new and answers once', async () => {
    const h = await arranged({ unopened: true });
    const delivery = { userId: MEMBER, channelId: PANEL_CHANNEL, idempotencyKey: 'evt-create' };

    await h.run(CREATE, delivery);
    await h.run(CREATE, delivery);

    expect(h.callbackTypes()).toEqual([DEFERRED]);
    expect(
      h.discordCalls().filter((call) => call.path === `/guilds/${GUILD}/channels`),
    ).toHaveLength(1);
    expect(h.ticket().number).toBe(1);

    const followups = h.followUpBodies();
    expect(followups).toHaveLength(1);
    expect(followups[0]?.body.flags).toBe(EPHEMERAL);
    expect(h.followUpContent()).toBe(`${S} Opened ticket #1 in <#${CREATED}>.`);
  });

  test('a redelivered /ticket create answers for the ticket the first delivery never announced', async () => {
    const h = await arranged({ unopened: true });
    const delivery = { userId: MEMBER, channelId: PANEL_CHANNEL, idempotencyKey: 'evt-create' };

    let down = true;
    h.rest.fail((call) => down && call.path.startsWith('/webhooks/'), UNAVAILABLE);

    await h.run(CREATE, delivery);
    down = false;
    await h.run(CREATE, delivery);

    expect(h.callbackTypes()).toEqual([DEFERRED]);
    expect(h.ticket().number).toBe(1);

    const followups = h.followUpBodies();
    expect(followups).toHaveLength(2);
    expect(followups[1]?.body.flags).toBe(EPHEMERAL);
    expect(followups[1]?.body.allowed_mentions).toEqual({ parse: [] });
    expect(h.followUpContent()).toBe(`${S} Opened ticket #1 in <#${CREATED}>.`);
  });

  test('a redelivered /ticket create stays silent while the first is mid-open, naming no older ticket', async () => {
    const h = await arranged({ unopened: true });
    await h.run(CREATE, { userId: MEMBER, channelId: PANEL_CHANNEL, idempotencyKey: 'evt-older' });

    const delivery = { userId: MEMBER, channelId: PANEL_CHANNEL, idempotencyKey: 'evt-newer' };

    let down = true;
    h.rest.fail((call) => down && call.path.startsWith('/webhooks/'), UNAVAILABLE);
    await h.run(CREATE, delivery);
    down = false;

    const newer = [...h.store.rows.values()].find((ticket) => ticket.number === 2);
    if (!newer) throw new Error('the second create opened nothing');
    h.store.rows.set(newer.id, { ...newer, channelId: newer.id });

    h.rest.calls.splice(0);
    await h.run(CREATE, delivery);

    expect(h.initialCallbacks()).toHaveLength(0);
    expect(h.followUpBodies()).toHaveLength(0);
  });

  test('the application id on the interaction is enough to defer when the deps carry none', async () => {
    const h = await arranged({});

    await h.run(subcommand('close'), {
      ...MOD,
      channelId: CREATED,
      ...withoutApplication(h),
      applicationId: OTHER_APPLICATION,
    });

    expectDeferredOnce(h);

    const followups = h.followUpBodies();
    expect(followups).toHaveLength(1);
    expect(followups[0]?.path).toBe(`/webhooks/${OTHER_APPLICATION}/interaction-token`);
    expect(h.followUpContent()).toBe(`${S} Closed ticket #1.`);
  });
});

describe('/ticket without an application id has no followup webhook', () => {
  const fallbacks = cases.filter((c) =>
    [
      'a create that opens a ticket',
      'a close that happens',
      'a delete support staff may not do',
      'a close outside any ticket',
      'a claim somebody else made first',
      'a list',
      'a transcript',
    ].includes(c.name),
  );

  for (const c of fallbacks) {
    test(`${c.name}: no defer, and the one private callback is the answer`, async () => {
      const h = await arranged(c);
      await h.run(c.options, { channelId: CREATED, ...c.as, ...withoutApplication(h) });

      const initial = h.initialCallbacks();
      expect(initial).toHaveLength(1);
      expect(initial[0]?.type).toBe(REPLY);
      expect(Number(initial[0]?.data.flags ?? 0) & EPHEMERAL).toBe(EPHEMERAL);
      expect(initial[0]?.data.allowed_mentions).toEqual({ parse: [] });
      expect(h.followUpBodies()).toHaveLength(0);

      expectText(h, c, h.replyContent());
    });
  }

  test('an info still carries both flags on its one callback', async () => {
    const h = await arranged({});
    await h.run(subcommand('info'), {
      userId: MEMBER,
      channelId: CREATED,
      ...withoutApplication(h),
    });

    const initial = h.initialCallbacks();
    expect(initial).toHaveLength(1);
    expect(initial[0]?.type).toBe(REPLY);
    expect(initial[0]?.data.flags).toBe(COMPONENTS_V2 | EPHEMERAL);
    expect(h.followUpBodies()).toHaveLength(0);
  });
});

describe('the tickets manifest', () => {
  test('declares interaction_followup, because every /ticket answer is one', () => {
    expect(createTicketsModule({}).actionKinds).toContain('interaction_followup');
  });
});
