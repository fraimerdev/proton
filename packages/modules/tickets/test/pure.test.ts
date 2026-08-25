import { describe, expect, test } from 'bun:test';
import { Permissions } from '@proton/core';
import {
  blankPanel,
  blankType,
  liftTicketsConfig,
  panelFor,
  renderChannelName,
  renderOpeningMessage,
  sanitiseChannelName,
  staffRolesFor,
  ticketPanelSchema,
  ticketsConfigSchema,
  ticketTypeSchema,
  transcriptChannelFor,
  typeFor,
  typesOf,
} from '../src/config.ts';
import {
  buildPanelComponents,
  describePriority,
  describeStatus,
  toEmoji,
} from '../src/interface.ts';
import { modalFieldsFor, needsModal, readIntakeAnswers } from '../src/modal.ts';
import {
  memberOverwrite,
  mergeOverwrites,
  OVERWRITE_MEMBER,
  OVERWRITE_ROLE,
  TICKET_LOCKED_DENY,
  TICKET_MEMBER_ALLOW,
  ticketOverwrites,
  withoutParticipant,
  withParticipant,
} from '../src/overwrites.ts';
import { autoCloseAt, autoDeleteAt, closeRequestAt, warnAt } from '../src/schedule.ts';
import type { Ticket } from '../src/store.ts';
import { GUILD, HELPER, MEMBER, PANEL_CHANNEL, SUPPORT_ROLE, TYPE } from './harness.ts';

const BOT = '300000000000000001';

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    guildId: GUILD,
    number: 42,
    typeId: 'support',
    panelId: 'support',
    channelId: '500000000000000002',
    openerId: MEMBER,
    ownerId: MEMBER,
    status: 'open',
    priority: 'medium',
    subject: null,
    claimedById: null,
    claimedAt: null,
    assignedToId: null,
    assignedById: null,
    assignedAt: null,
    lockedAt: null,
    lockedById: null,
    waitingOn: null,
    openedAt: new Date('2026-08-24T12:00:00Z'),
    lastActivityAt: new Date('2026-08-24T12:00:00Z'),
    lastUserMessageAt: null,
    lastStaffMessageAt: null,
    firstResponseAt: null,
    closeRequestedById: null,
    closeRequestedAt: null,
    closedAt: null,
    closedBy: null,
    closeReason: null,
    archivedAt: null,
    deletedAt: null,
    messageCount: 0,
    transcriptUrl: null,
    ...overrides,
  };
}

describe('channel naming', () => {
  test('replaces every placeholder, so a pattern using all three is fully rendered', () => {
    expect(renderChannelName('{type}-{number}-{user}', 7, 'Fraimer', 'Billing')).toBe(
      'billing-7-fraimer',
    );
  });

  test('collapses punctuation a member controls, so a nickname cannot break the channel name', () => {
    expect(renderChannelName('ticket-{user}', 1, 'a!!!b   c')).toBe('ticket-a-b-c');
  });

  test('falls back to a real name when a pattern sanitises to nothing, which Discord refuses', () => {
    expect(sanitiseChannelName('!!!')).toBe('ticket');
    expect(sanitiseChannelName('')).toBe('ticket');
  });

  test('trims to Discord’s hundred-character ceiling rather than being refused at the API', () => {
    expect(renderChannelName(`${'a'.repeat(200)}-{number}`, 1, 'x').length).toBeLessThanOrEqual(
      100,
    );
  });

  test('renders the opener as a real mention, so the welcome message pings them', () => {
    expect(renderOpeningMessage('hello {user}', MEMBER)).toBe(`hello <@${MEMBER}>`);
  });
});

describe('config lookups', () => {
  const config = ticketsConfigSchema.parse({
    staffRoleIds: ['410000000000000001'],
    transcriptChannelId: '500000000000000004',
    types: [
      { id: 'support', name: 'Support', staffRoleIds: [SUPPORT_ROLE] },
      { id: 'billing', name: 'Billing', transcriptChannelId: '500000000000000005' },
    ],
    panels: [
      { id: 'main', name: 'Main', channelId: '500000000000000001', typeIds: ['support', 'gone'] },
    ],
  });

  test('finds a panel and a type by id, and answers undefined for one that was removed', () => {
    expect(panelFor(config, 'main')?.name).toBe('Main');
    expect(panelFor(config, 'nope')).toBeUndefined();
    expect(typeFor(config, 'billing')?.name).toBe('Billing');
    expect(typeFor(config, 'nope')).toBeUndefined();
  });

  test('drops a type id a panel still lists but the config no longer has, rather than crashing', () => {
    const panel = config.panels[0];
    if (!panel) throw new Error('the fixture lost its panel');

    const resolved = typesOf(config, panel);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.id).toBe('support');
  });

  test('a type’s staff roles are added to the server-wide ones, never replacing them', () => {
    expect(staffRolesFor(config, typeFor(config, 'support'))).toEqual([
      '410000000000000001',
      SUPPORT_ROLE,
    ]);
  });

  test('the type’s own transcript channel wins, and the server default fills in when it has none', () => {
    expect(transcriptChannelFor(config, typeFor(config, 'billing'))).toBe('500000000000000005');
    expect(transcriptChannelFor(config, typeFor(config, 'support'))).toBe('500000000000000004');
  });

  test('a blank row is built by the schema, so the dashboard cannot drift from what saves', () => {
    expect(ticketTypeSchema.safeParse(blankType(0)).success).toBe(true);
    expect(blankPanel(0, ['support']).typeIds).toEqual(['support']);
  });

  test('a new panel is invalid until a channel is picked, and only because of that channel', () => {
    const blank = blankPanel(0, ['support']);
    const parsed = ticketPanelSchema.safeParse(blank);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['channelId']);
    expect(ticketPanelSchema.safeParse({ ...blank, channelId: PANEL_CHANNEL }).success).toBe(true);
  });
});

describe('the version 1 lift', () => {
  const v1 = {
    enabled: true,
    panels: [
      {
        id: 'support',
        name: 'Support',
        channelId: '500000000000000001',
        categoryId: '500000000000000009',
        buttonLabel: 'Open',
        panelText: 'Need a hand?',
        openingMessage: '{user} opened a ticket.',
        supportRoleIds: [SUPPORT_ROLE],
        transcriptChannelId: '500000000000000004',
        autoCloseAfter: '48h',
      },
    ],
  };

  test('turns each version 1 panel into a type, because Zod would otherwise strip every key', () => {
    const config = ticketsConfigSchema.parse(liftTicketsConfig(v1));
    const type = config.types[0];

    expect(config.panels[0]?.typeIds).toEqual(['support']);
    expect(type?.staffRoleIds).toEqual([SUPPORT_ROLE]);
    expect(type?.categoryId).toBe('500000000000000009');
    expect(type?.autoCloseAfter).toBe('48h');
    expect(type?.transcriptChannelId).toBe('500000000000000004');
    expect(type?.welcomeMessage).toBe('{user} opened a ticket.');
  });

  test('keeps version 1’s delete-on-close, so upgrading does not fill a server with dead channels', () => {
    const config = ticketsConfigSchema.parse(liftTicketsConfig(v1));

    expect(config.types[0]?.autoDeleteAfter).toBe('1s');
    expect(config.types[0]?.reopenEnabled).toBe(false);
  });

  test('is idempotent, because it runs on every read as well as every write', () => {
    const once = liftTicketsConfig(v1);

    expect(liftTicketsConfig(once)).toEqual(once);
  });

  test('leaves a version 2 config completely alone', () => {
    const v2 = ticketsConfigSchema.parse({
      types: [{ id: 'a', name: 'A' }],
      panels: [{ id: 'p', name: 'P', channelId: '500000000000000003', typeIds: ['a'] }],
    });

    expect(liftTicketsConfig(v2)).toEqual(v2);
  });

  test('survives the shapes a stored config can degenerate to rather than throwing', () => {
    expect(liftTicketsConfig(null)).toBeNull();
    expect(liftTicketsConfig({})).toEqual({});
    expect(liftTicketsConfig({ panels: 'not an array' })).toEqual({ panels: 'not an array' });
  });
});

describe('permission overwrites', () => {
  const base = {
    guildId: GUILD,
    ownerId: MEMBER,
    staffRoleIds: [SUPPORT_ROLE],
    botUserId: BOT,
  };

  test('denies @everyone ViewChannel, which is the whole reason a ticket is private', () => {
    const everyone = ticketOverwrites(base).find((entry) => entry.id === GUILD);

    expect(everyone?.type).toBe(OVERWRITE_ROLE);
    expect(BigInt(everyone?.deny ?? '0') & Permissions.ViewChannel).toBe(Permissions.ViewChannel);
  });

  test('lists the owner and the bot once each, even when they are the same account', () => {
    const overwrites = ticketOverwrites({ ...base, ownerId: BOT });
    const forBot = overwrites.filter((entry) => entry.id === BOT);

    expect(forBot).toHaveLength(1);
  });

  test('never emits the @everyone role as an allow, which would make the ticket public', () => {
    const overwrites = ticketOverwrites({ ...base, staffRoleIds: [GUILD, SUPPORT_ROLE] });
    const allows = overwrites.filter((entry) => entry.id === GUILD && entry.allow !== undefined);

    expect(allows).toHaveLength(0);
  });

  test('grants no bit beyond TICKET_MEMBER_ALLOW, or the bot must hold it to create a ticket', () => {
    let granted = 0n;
    for (const entry of ticketOverwrites({ ...base, participantIds: [HELPER] })) {
      granted |= BigInt(entry.allow ?? '0');
    }

    expect(granted & ~TICKET_MEMBER_ALLOW).toBe(0n);
  });

  test('a locked ticket keeps the member reading and stops them writing', () => {
    const locked = memberOverwrite(MEMBER, true);

    expect(BigInt(locked.deny ?? '0') & Permissions.SendMessages).toBe(Permissions.SendMessages);
    expect(BigInt(locked.allow ?? '0') & Permissions.ViewChannel).toBe(Permissions.ViewChannel);
    expect(BigInt(locked.deny ?? '0')).toBe(TICKET_LOCKED_DENY);
  });

  test('adding a participant twice changes nothing, so a double press cannot duplicate a row', () => {
    const once = withParticipant(ticketOverwrites(base), HELPER);

    expect(withParticipant(once, HELPER)).toEqual(once);
  });

  test('removing a participant leaves every role overwrite in place', () => {
    const withHelper = withParticipant(ticketOverwrites(base), HELPER);
    const without = withoutParticipant(withHelper, HELPER);

    expect(without.some((entry) => entry.id === HELPER)).toBe(false);
    expect(without.some((entry) => entry.id === SUPPORT_ROLE)).toBe(true);
    expect(without.some((entry) => entry.id === GUILD)).toBe(true);
  });

  test('merging keeps every required entry, so a stale cache cannot drop the @everyone deny', () => {
    const required = ticketOverwrites(base);
    const merged = mergeOverwrites(
      [{ id: HELPER, type: OVERWRITE_MEMBER, allow: TICKET_MEMBER_ALLOW.toString() }],
      required,
    );

    for (const entry of required) {
      expect(merged).toContainEqual(entry);
    }
    expect(merged.some((entry) => entry.id === HELPER)).toBe(true);
  });
});

describe('rendering a ticket', () => {
  test('reads a unicode emoji as a name and a custom one as an id, or Discord refuses it', () => {
    expect(toEmoji('🎫')).toEqual({ name: '🎫' });
    expect(toEmoji('<:proton:123456789012345678>')).toEqual({
      id: '123456789012345678',
      name: 'proton',
      animated: false,
    });
    expect(toEmoji('<a:spin:123456789012345678>')?.animated).toBe(true);
    expect(toEmoji(undefined)).toBeUndefined();
  });

  test('says what is actually true of a ticket, not merely which column it is in', () => {
    expect(describeStatus(ticket())).toBe('Open');
    expect(describeStatus(ticket({ waitingOn: 'staff' }))).toBe('Open · Waiting on staff');
    expect(describeStatus(ticket({ waitingOn: 'user' }))).toBe('Open · Waiting on the member');
    expect(describeStatus(ticket({ lockedAt: new Date() }))).toBe('Open · Locked');
    expect(describeStatus(ticket({ closeRequestedAt: new Date() }))).toBe('Open · Close requested');
    expect(describeStatus(ticket({ status: 'closed' }))).toBe('Closed');
    expect(describeStatus(ticket({ status: 'archived' }))).toBe('Archived');
    expect(describeStatus(ticket({ status: 'deleted' }))).toBe('Deleted');
  });

  test('a locked ticket reads as locked even while it waits, because locking is the louder fact', () => {
    expect(describeStatus(ticket({ lockedAt: new Date(), waitingOn: 'staff' }))).toBe(
      'Open · Locked',
    );
  });

  test('names a priority in words only, because Proton ships no stock emoji of its own', () => {
    expect(describePriority('urgent')).toBe('Urgent');
    expect(describePriority('low')).toBe('Low');
  });

  test('refuses a panel with no ticket types instead of posting buttons that open nothing', () => {
    const built = buildPanelComponents({ ...TYPE, ...blankPanel(0) }, []);

    expect(built.ok).toBe(false);
  });

  test('builds a select menu when the panel asks for one, so many types stay readable', () => {
    const panel = ticketPanelSchema.parse({
      id: 'p',
      name: 'P',
      channelId: '500000000000000001',
      typeIds: ['support'],
      style: 'select',
    });

    const built = buildPanelComponents(panel, [TYPE]);
    expect(built.ok).toBe(true);
    expect(JSON.stringify(built)).toContain('proton:tickets:os:p');
  });

  test('a button panel carries one button per type, each naming its own type', () => {
    const second = ticketTypeSchema.parse({ id: 'billing', name: 'Billing' });
    const panel = ticketPanelSchema.parse({
      id: 'p',
      name: 'P',
      channelId: '500000000000000001',
      typeIds: ['support', 'billing'],
    });

    const built = buildPanelComponents(panel, [TYPE, second]);
    const json = JSON.stringify(built);

    expect(built.ok).toBe(true);
    expect(json).toContain('proton:tickets:ot:p:support');
    expect(json).toContain('proton:tickets:ot:p:billing');
  });
});

describe('intake forms', () => {
  const field = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: id,
    style: 'short' as const,
    required: true,
    options: [],
    ...extra,
  });

  test('never offers more than the five components Discord takes in a modal', () => {
    const type = ticketTypeSchema.parse({
      id: 't',
      name: 'T',
      form: ['a', 'b', 'c', 'd', 'e'].map((id) => field(id)),
    });

    expect(modalFieldsFor(type)).toHaveLength(5);
  });

  test('the priority picker displaces a field rather than pushing the modal over the cap', () => {
    const type = ticketTypeSchema.parse({
      id: 't',
      name: 'T',
      askPriority: true,
      form: ['a', 'b', 'c', 'd', 'e'].map((id) => field(id)),
    });

    expect(modalFieldsFor(type)).toHaveLength(4);
  });

  test('drops a select with no options, which Discord refuses and would take the ticket with it', () => {
    const type = ticketTypeSchema.parse({
      id: 't',
      name: 'T',
      form: [field('empty', { style: 'select', options: [] }), field('kept')],
    });

    expect(modalFieldsFor(type).map((entry) => entry.id)).toEqual(['kept']);
  });

  test('only asks for a modal when there is something to ask', () => {
    expect(needsModal(ticketTypeSchema.parse({ id: 't', name: 'T' }))).toBe(false);
    expect(needsModal(ticketTypeSchema.parse({ id: 't', name: 'T', askPriority: true }))).toBe(
      true,
    );
    expect(needsModal(ticketTypeSchema.parse({ id: 't', name: 'T', form: [field('a')] }))).toBe(
      true,
    );
  });

  test('reads text and select answers, and takes the first as the subject line', () => {
    const type = ticketTypeSchema.parse({
      id: 't',
      name: 'T',
      askPriority: true,
      form: [
        field('what', { label: 'What happened?' }),
        field('device', { style: 'select', options: [{ label: 'Windows', value: 'win' }] }),
      ],
    });

    const read = readIntakeAnswers(
      type,
      { what: '  cannot log in  ' },
      { device: ['win'], _priority: ['high'] },
    );

    expect(read.answers).toHaveLength(2);
    expect(read.answers[0]).toMatchObject({ fieldId: 'what', value: 'cannot log in' });
    expect(read.answers[1]).toMatchObject({ fieldId: 'device', value: 'win' });
    expect(read.priority).toBe('high');
    expect(read.subject).toBe('cannot log in');
  });

  test('ignores a priority the build does not know, so a forged modal cannot invent one', () => {
    const type = ticketTypeSchema.parse({ id: 't', name: 'T', askPriority: true });

    expect(readIntakeAnswers(type, {}, { _priority: ['catastrophic'] }).priority).toBeNull();
  });

  test('skips an empty optional answer instead of storing a blank row', () => {
    const type = ticketTypeSchema.parse({
      id: 't',
      name: 'T',
      form: [field('a', { required: false })],
    });

    expect(readIntakeAnswers(type, { a: '   ' }, {}).answers).toHaveLength(0);
  });
});

describe('when each timer is due', () => {
  const withType = (extra: Record<string, unknown>) =>
    ticketTypeSchema.parse({ id: 'support', name: 'Support', ...extra });

  test('an auto-close is measured from the last activity, not from when the ticket opened', () => {
    const due = autoCloseAt(withType({ autoCloseAfter: '2h' }), ticket());

    expect(due?.toISOString()).toBe('2026-08-24T14:00:00.000Z');
  });

  test('nothing is due when the type asks for nothing, so no row is booked at all', () => {
    expect(autoCloseAt(withType({}), ticket())).toBeNull();
    expect(warnAt(withType({}), ticket())).toBeNull();
    expect(autoDeleteAt(withType({}), ticket({ status: 'closed' }))).toBeNull();
  });

  test('a closed ticket has no auto-close and an open one has no auto-delete', () => {
    expect(
      autoCloseAt(withType({ autoCloseAfter: '2h' }), ticket({ status: 'closed' })),
    ).toBeNull();
    expect(autoDeleteAt(withType({ autoDeleteAfter: '2h' }), ticket())).toBeNull();
  });

  test('a close request expires from when it was made, and only while one is outstanding', () => {
    const type = withType({ closeRequestExpiresAfter: '1h' });

    expect(closeRequestAt(type, ticket())).toBeNull();
    expect(
      closeRequestAt(
        type,
        ticket({ closeRequestedAt: new Date('2026-08-24T15:00:00Z') }),
      )?.toISOString(),
    ).toBe('2026-08-24T16:00:00.000Z');
  });

  test('a duration a tightened schema would now reject returns null rather than throwing', () => {
    const type = { ...withType({}), autoCloseAfter: 'whenever' };

    expect(autoCloseAt(type, ticket())).toBeNull();
  });

  test('an absent type answers null, because a removed type must not book anything', () => {
    expect(autoCloseAt(undefined, ticket())).toBeNull();
    expect(autoDeleteAt(undefined, ticket({ status: 'closed' }))).toBeNull();
  });
});
