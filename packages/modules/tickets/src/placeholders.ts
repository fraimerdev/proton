import type { TicketPriority } from '@proton/core';
import {
  aliasValues,
  type BotFacts,
  type BuildEnv,
  botDefinitions,
  buildBotValues,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  clipGraphemes,
  collectConfigTemplates,
  definePlaceholderSurface,
  isRestricted,
  lookupFrom,
  type MemberFacts,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  type PlaceholderValue,
  parseTemplate,
  type ResolvedValue,
  renderTemplate,
  SAMPLE_BOT,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  SAMPLE_TICKET_CLOSED,
  SAMPLE_TICKET_OPEN,
  type ServerFacts,
  type SurfaceSample,
  serverDefinitions,
  type TemplateFieldSpec,
  timeDefinitions,
  typeOf,
  type UserFacts,
  unavailableReason,
  userDefinitions,
  placeholderValue as v,
  withAliases,
  withAvailability,
} from '@proton/core/placeholders';
import { CHANNEL_NAME_MAX, sanitiseChannelName } from './channel-name.ts';
import { PRIORITY_LABELS } from './constants.ts';

export const TICKET_TEXT_MAX = 2000;

export const TICKET_SURFACE_EVENTS = {
  name: 'tickets.channel_name',
  welcome: 'tickets.welcome',
  close: 'tickets.close',
  blacklist: 'tickets.blacklist',
  response: 'tickets.response',
} as const;

export interface TicketRecordFacts {
  id: string;
  number: number;
  priority: TicketPriority;
  subject: string | null;
  openedAt: Date;
  ownerId: string;
  openerId: string;
  channelId: string;
  claimedById: string | null;
  assignedToId: string | null;
}

export interface TicketAnswerFacts {
  fieldId: string;
  value: string;
}

export interface TicketCloseFacts {
  closedById: string;
  reason: string | null;
}

export interface TicketBlacklistFacts {
  reason: string | null;
  expiresAt: Date | null;
}

export interface TicketPlaceholderFacts {
  ticket: TicketRecordFacts | null;
  typeName: string;
  priority?: TicketPriority | undefined;
  ownerId: string;
  owner?: UserFacts | null | undefined;
  answers?: readonly TicketAnswerFacts[] | undefined;
  participantCount?: number | undefined;
  close?: TicketCloseFacts | undefined;
  blacklist?: TicketBlacklistFacts | undefined;
  actorId?: string | undefined;
  actor?: UserFacts | null | undefined;
  actorMember?: MemberFacts | undefined;
  server: ServerFacts | null;
  bot: BotFacts | null;
}

export interface TicketNameFacts {
  number: number;
  typeName: string;
  ownerId: string;
  owner?: UserFacts | null | undefined;
  legacyUserName: string;
  server: ServerFacts | null;
}

export interface TicketSources {
  owner: boolean;
  actor: boolean;
  server: boolean;
  bot: boolean;
  answers: boolean;
  participants: boolean;
}

const SNOWFLAKE = /^\d{17,20}$/;

const ANSWER_KEY = 'ticket.answer.<question_key>';

const ANSWER_PREFIX = 'ticket.answer.';

const REFRESHES = 'Updates when the ticket panel refreshes.';

type Entry = readonly [label: string, description: string, example: PlaceholderValue];

const TICKET_ENTRIES = {
  'ticket.number': ['Ticket number', 'The number of this ticket', v.integer(42)],
  'ticket.type_name': ['Ticket type', 'The name of the ticket type', v.text('Billing')],
  'ticket.priority': ['Priority', 'Low, Medium, High or Urgent', v.text('Medium')],
  'ticket.subject': [
    'Subject',
    'The one-line summary the member gave; empty when they gave none',
    v.text('Refund for order 1182'),
  ],
  'ticket.opener_mention': [
    'Opened by',
    'Who opened the ticket. After a transfer this is still the opener; {user.mention} is the current owner.',
    v.user('100000000000000010', 'Fraimer'),
  ],
  'ticket.opened_at': ['Opened', 'When the ticket was opened', v.datetime(SAMPLE_NOW)],
  'ticket.channel_mention': [
    'Ticket channel',
    'The ticket channel as a clickable mention',
    v.channel('100000000000000060', 'ticket-42'),
  ],
  'ticket.claimed_by': [
    'Claimed by',
    `The staff member who claimed the ticket; empty when nobody has. ${REFRESHES}`,
    v.user('100000000000000030', 'Helper'),
  ],
  'ticket.assigned_to': [
    'Assigned to',
    `Who the ticket is assigned to; empty when nobody is. ${REFRESHES}`,
    v.user('100000000000000030', 'Helper'),
  ],
  'ticket.participant_count': [
    'Participants',
    `How many members are in the ticket, the opener included. ${REFRESHES}`,
    v.integer(1),
  ],
  'ticket.closed_by': [
    'Closed by',
    'Who closed the ticket',
    v.user('100000000000000030', 'Helper'),
  ],
  'ticket.close_reason': [
    'Close reason',
    'Why the ticket was closed; empty when no reason was given',
    v.text('Refund issued'),
  ],
  [ANSWER_KEY]: [
    'Form answer',
    "The member's answer to one question on the ticket form, named by the question's id, as in {ticket.answer.order}",
    v.text('1182'),
  ],
  'ticket.blacklist_reason': [
    'Block reason',
    'Why the member may not open tickets; empty when no reason was given',
    v.text('Spamming tickets'),
  ],
  'ticket.blacklist_expires_at': [
    'Block lifts',
    'When the member may open tickets again; empty when the block is permanent',
    v.datetime(SAMPLE_NOW + 7 * 86_400_000),
  ],
} satisfies Record<string, Entry>;

type TicketKey = keyof typeof TICKET_ENTRIES;

const PRIVATE_KEYS: ReadonlySet<string> = new Set([
  'ticket.subject',
  'ticket.close_reason',
  ANSWER_KEY,
  'ticket.blacklist_reason',
  'ticket.blacklist_expires_at',
]);

const RECORD_KEYS = [
  'ticket.number',
  'ticket.subject',
  'ticket.opener_mention',
  'ticket.opened_at',
  'ticket.channel_mention',
  'ticket.claimed_by',
  'ticket.assigned_to',
] as const satisfies readonly TicketKey[];

const OPEN_TICKET_KEYS = [
  ...RECORD_KEYS,
  'ticket.type_name',
  'ticket.priority',
] as const satisfies readonly TicketKey[];

const PROFILE_KEYS: ReadonlySet<string> = new Set([
  'username',
  'global_name',
  'display_name',
  'avatar_url',
  'is_bot',
]);

function ticketDefinition(key: TicketKey): PlaceholderDefinitionInput {
  const [label, description, example] = TICKET_ENTRIES[key];

  return {
    key,
    label,
    description,
    group: 'Ticket',
    type: typeOf(example),
    example,
    sensitivity: PRIVATE_KEYS.has(key) ? 'member_private' : 'public',
  };
}

function account(
  namespace: 'user' | 'actor',
  aliases: Readonly<Record<string, readonly string[]>> = {},
): PlaceholderDefinitionInput[] {
  return userDefinitions(namespace, { member: false }).map((definition) =>
    Object.hasOwn(aliases, definition.key)
      ? withAliases(definition, aliases[definition.key] ?? [])
      : definition,
  );
}

const ANSWERS_ONLY_IN = [TICKET_SURFACE_EVENTS.welcome, TICKET_SURFACE_EVENTS.response];

function nameDefinitions(): PlaceholderDefinitionInput[] {
  return [
    withAliases(ticketDefinition('ticket.number'), ['number']),
    withAliases(ticketDefinition('ticket.type_name'), ['type']),
    ticketDefinition('ticket.subject'),
    ticketDefinition(ANSWER_KEY),
    ...account('user', { 'user.global_name': ['user'] }),
    ...serverDefinitions().filter(({ key }) => key === 'server.name'),
    ...timeDefinitions(),
  ];
}

function welcomeDefinitions(): PlaceholderDefinitionInput[] {
  return [
    ...OPEN_TICKET_KEYS.map(ticketDefinition),
    ticketDefinition('ticket.participant_count'),
    ticketDefinition(ANSWER_KEY),
    ...account('user', { 'user.mention': ['user'] }),
    ...serverDefinitions(),
    ...botDefinitions(),
    ...timeDefinitions(),
  ];
}

function closeDefinitions(): PlaceholderDefinitionInput[] {
  return [
    ...OPEN_TICKET_KEYS.map(ticketDefinition),
    ticketDefinition('ticket.closed_by'),
    ticketDefinition('ticket.close_reason'),
    withAvailability(ticketDefinition(ANSWER_KEY), ANSWERS_ONLY_IN),
    ...account('user'),
    ...account('actor'),
    ...serverDefinitions(),
    ...botDefinitions(),
    ...timeDefinitions(),
  ];
}

function blacklistDefinitions(): PlaceholderDefinitionInput[] {
  return [
    withAvailability(ticketDefinition('ticket.number'), [
      TICKET_SURFACE_EVENTS.welcome,
      TICKET_SURFACE_EVENTS.close,
      TICKET_SURFACE_EVENTS.response,
    ]),
    ticketDefinition('ticket.type_name'),
    ticketDefinition('ticket.priority'),
    withAvailability(ticketDefinition(ANSWER_KEY), ANSWERS_ONLY_IN),
    ticketDefinition('ticket.blacklist_reason'),
    ticketDefinition('ticket.blacklist_expires_at'),
    ...account('user'),
    ...serverDefinitions(),
    ...botDefinitions(),
    ...timeDefinitions(),
  ];
}

function responseDefinitions(): PlaceholderDefinitionInput[] {
  return [
    ...OPEN_TICKET_KEYS.map(ticketDefinition),
    ticketDefinition('ticket.participant_count'),
    ticketDefinition(ANSWER_KEY),
    ...account('user'),
    ...account('actor'),
    ...serverDefinitions(),
    ...botDefinitions(),
    ...timeDefinitions(),
  ];
}

const NOT_AN_ID = 'the id Proton holds is not a Discord id';

function whole(value: number, what: string): ResolvedValue {
  return Number.isSafeInteger(value)
    ? v.integer(value)
    : v.failed(`${what} Proton holds is not a whole number`);
}

function userMention(id: string): ResolvedValue {
  return SNOWFLAKE.test(id) ? v.user(id) : v.failed(NOT_AN_ID);
}

function optionalUser(id: string | null): ResolvedValue {
  return id === null ? v.notSet() : userMention(id);
}

function optionalText(value: string | null): ResolvedValue {
  return value === null || value === '' ? v.notSet() : v.text(value);
}

function dateValue(at: Date | null): ResolvedValue {
  if (at === null) return v.notSet();

  const ms = at.getTime();
  return Number.isSafeInteger(ms)
    ? v.datetime(ms)
    : v.failed('the date Proton holds is not a date');
}

function priorityValue(priority: TicketPriority | undefined): ResolvedValue {
  if (priority === undefined) return v.unavailable('Proton does not know the priority here');

  return Object.hasOwn(PRIORITY_LABELS, priority)
    ? v.text(PRIORITY_LABELS[priority])
    : v.failed('the priority Proton holds is not one it knows');
}

function personValues(
  ns: 'user' | 'actor',
  id: string,
  profile: UserFacts | null | undefined,
  member: MemberFacts | null,
  now: number,
): Record<string, ResolvedValue> {
  const read = profile !== undefined && profile !== null && profile.id === id ? profile : null;
  const values = buildUserValues(
    ns,
    read ?? { id, username: null, globalName: null, avatarHash: null },
    member,
    now,
  );

  if (read !== null) return values;

  const absent =
    profile === undefined
      ? v.unavailable('Proton did not read this profile for the message')
      : v.failed('Proton could not read this profile');

  for (const key of PROFILE_KEYS) values[`${ns}.${key}`] = absent;
  return values;
}

function ticketValues(facts: TicketPlaceholderFacts): Record<string, ResolvedValue> {
  const { ticket, close, blacklist } = facts;
  const notClosing = v.unavailable('this message is not about a ticket closing');
  const notBlocked = v.unavailable('this message is not about a blocked member');

  const values: Record<string, ResolvedValue> = {
    'ticket.type_name': v.text(facts.typeName),
    'ticket.priority': priorityValue(ticket?.priority ?? facts.priority),
    'ticket.participant_count':
      facts.participantCount === undefined
        ? v.unavailable('Proton did not count who is in this ticket')
        : whole(facts.participantCount, 'the participant count'),
    'ticket.closed_by': close === undefined ? notClosing : userMention(close.closedById),
    'ticket.close_reason': close === undefined ? notClosing : optionalText(close.reason),
    'ticket.blacklist_reason':
      blacklist === undefined ? notBlocked : optionalText(blacklist.reason),
    'ticket.blacklist_expires_at':
      blacklist === undefined ? notBlocked : dateValue(blacklist.expiresAt),
  };

  if (ticket === null) {
    const unopened = v.unavailable('no ticket has been opened for this message');
    for (const key of RECORD_KEYS) values[key] = unopened;
    return values;
  }

  return {
    ...values,
    'ticket.number': whole(ticket.number, 'the ticket number'),
    'ticket.subject': optionalText(ticket.subject),
    'ticket.opener_mention': userMention(ticket.openerId),
    'ticket.opened_at': dateValue(ticket.openedAt),
    'ticket.channel_mention': SNOWFLAKE.test(ticket.channelId)
      ? v.channel(ticket.channelId)
      : v.failed(NOT_AN_ID),
    'ticket.claimed_by': optionalUser(ticket.claimedById),
    'ticket.assigned_to': optionalUser(ticket.assignedToId),
  };
}

function answerValue(
  answers: readonly TicketAnswerFacts[] | undefined,
  params: Readonly<Record<string, string>>,
): ResolvedValue {
  if (answers === undefined) return v.unavailable('Proton did not load the form answers here');

  const key = Object.hasOwn(params, 'question_key') ? params.question_key : undefined;
  const answer = key === undefined ? undefined : answers.find((entry) => entry.fieldId === key);

  return answer === undefined || answer.value === ''
    ? v.notSet('the member gave no answer to that question')
    : v.text(answer.value);
}

function ticketLookup(facts: TicketPlaceholderFacts, env: BuildEnv): PlaceholderLookup {
  const values = lookupFrom({
    ...personValues('user', facts.ownerId, facts.owner, null, env.now),
    ...(facts.actorId === undefined
      ? {}
      : personValues('actor', facts.actorId, facts.actor, facts.actorMember ?? null, env.now)),
    ...buildServerValues(facts.server),
    ...buildBotValues(facts.bot),
    ...buildTimeValues(env.now),
    ...ticketValues(facts),
  });
  const { answers } = facts;

  return (request) =>
    request.definition.key === ANSWER_KEY ? answerValue(answers, request.params) : values(request);
}

function nameLookup(facts: TicketNameFacts, env: BuildEnv): PlaceholderLookup {
  const server = buildServerValues(facts.server);

  return aliasValues(
    lookupFrom({
      ...personValues('user', facts.ownerId, facts.owner, null, env.now),
      'server.name': server['server.name'] ?? v.unavailable(),
      ...buildTimeValues(env.now),
      'ticket.number': whole(facts.number, 'the ticket number'),
      'ticket.type_name': v.text(facts.typeName),
    }),
    { user: v.text(facts.legacyUserName) },
  );
}

const SAMPLE_OWNER = SAMPLE_MEMBER.user;

const SAMPLE_STAFF: UserFacts = {
  id: SAMPLE_TICKET_CLOSED.closedById,
  username: 'helper',
  globalName: 'Helper',
  avatarHash: null,
};

const SAMPLE_RECORD: TicketRecordFacts = {
  id: '01J8Z3K5N2V7Q4R6T8W0X2Y4Z6',
  number: SAMPLE_TICKET_OPEN.number,
  priority: SAMPLE_TICKET_OPEN.priority,
  subject: SAMPLE_TICKET_OPEN.subject,
  openedAt: new Date(SAMPLE_TICKET_OPEN.openedAt),
  ownerId: SAMPLE_OWNER.id,
  openerId: SAMPLE_OWNER.id,
  channelId: '100000000000000060',
  claimedById: SAMPLE_TICKET_OPEN.claimedById,
  assignedToId: null,
};

const SAMPLE_WHERE = `${SAMPLE_TICKET_OPEN.typeName} ticket #${SAMPLE_TICKET_OPEN.number} in ${SAMPLE_SERVER.name ?? 'Proton HQ'}`;

const OPENED: TicketPlaceholderFacts = {
  ticket: SAMPLE_RECORD,
  typeName: SAMPLE_TICKET_OPEN.typeName,
  ownerId: SAMPLE_OWNER.id,
  owner: SAMPLE_OWNER,
  answers: SAMPLE_TICKET_OPEN.answers.map(({ key, value }) => ({ fieldId: key, value })),
  participantCount: 1,
  server: SAMPLE_SERVER,
  bot: SAMPLE_BOT,
};

const NAME_SAMPLE: SurfaceSample<TicketNameFacts> = {
  id: 'ticket_opened',
  label: `Sample: ${SAMPLE_OWNER.globalName ?? 'Fraimer'} opening ${SAMPLE_WHERE}`,
  facts: {
    number: SAMPLE_TICKET_OPEN.number,
    typeName: SAMPLE_TICKET_OPEN.typeName,
    ownerId: SAMPLE_OWNER.id,
    owner: SAMPLE_OWNER,
    legacyUserName: SAMPLE_OWNER.globalName ?? 'Fraimer',
    server: SAMPLE_SERVER,
  },
};

const WELCOME_SAMPLE: SurfaceSample<TicketPlaceholderFacts> = {
  id: 'ticket_opened',
  label: `Sample: ${SAMPLE_OWNER.globalName ?? 'Fraimer'} opening ${SAMPLE_WHERE}`,
  facts: OPENED,
};

const CLOSE_SAMPLE: SurfaceSample<TicketPlaceholderFacts> = {
  id: 'ticket_closed',
  label: `Sample: ${SAMPLE_STAFF.globalName ?? 'Helper'} closing ${SAMPLE_WHERE}`,
  facts: {
    ticket: SAMPLE_RECORD,
    typeName: SAMPLE_TICKET_CLOSED.typeName,
    ownerId: SAMPLE_OWNER.id,
    owner: SAMPLE_OWNER,
    close: { closedById: SAMPLE_STAFF.id, reason: SAMPLE_TICKET_CLOSED.closeReason },
    actorId: SAMPLE_STAFF.id,
    actor: SAMPLE_STAFF,
    server: SAMPLE_SERVER,
    bot: SAMPLE_BOT,
  },
};

const BLACKLIST_SAMPLE: SurfaceSample<TicketPlaceholderFacts> = {
  id: 'member',
  label: `Sample: ${SAMPLE_OWNER.globalName ?? 'Fraimer'} blocked from opening a ${SAMPLE_TICKET_OPEN.typeName} ticket`,
  facts: {
    ticket: null,
    typeName: SAMPLE_TICKET_OPEN.typeName,
    priority: SAMPLE_TICKET_OPEN.priority,
    ownerId: SAMPLE_OWNER.id,
    owner: SAMPLE_OWNER,
    blacklist: { reason: 'Spamming tickets', expiresAt: new Date(SAMPLE_NOW + 7 * 86_400_000) },
    server: SAMPLE_SERVER,
    bot: SAMPLE_BOT,
  },
};

const RESPONSE_SAMPLE: SurfaceSample<TicketPlaceholderFacts> = {
  id: 'ticket_opened',
  label: `Sample: ${SAMPLE_STAFF.globalName ?? 'Helper'} replying in ${SAMPLE_WHERE}`,
  facts: { ...OPENED, actorId: SAMPLE_STAFF.id, actor: SAMPLE_STAFF },
};

function textField(path: string, label: string): TemplateFieldSpec {
  return { path, kind: 'discord_text', label, limit: TICKET_TEXT_MAX };
}

function nameField(path: string): TemplateFieldSpec {
  return {
    path,
    kind: 'plain_text',
    label: 'Name pattern',
    limit: CHANNEL_NAME_MAX,
    finish: sanitiseChannelName,
  };
}

export const TICKET_NAME_SURFACE = definePlaceholderSurface<TicketNameFacts>({
  id: TICKET_SURFACE_EVENTS.name,
  module: 'tickets',
  label: 'Ticket channel name',
  event: TICKET_SURFACE_EVENTS.name,
  audience: 'public',
  fields: [nameField('namePattern'), nameField('types.*.namePattern')],
  definitions: nameDefinitions(),
  build: nameLookup,
  samples: [NAME_SAMPLE],
});

export const TICKET_WELCOME_SURFACE = definePlaceholderSurface<TicketPlaceholderFacts>({
  id: TICKET_SURFACE_EVENTS.welcome,
  module: 'tickets',
  label: 'Ticket opening message',
  event: TICKET_SURFACE_EVENTS.welcome,
  audience: 'member_private',
  fields: [textField('types.*.welcomeMessage', 'Opening message')],
  definitions: welcomeDefinitions(),
  build: ticketLookup,
  samples: [WELCOME_SAMPLE],
});

export const TICKET_CLOSE_SURFACE = definePlaceholderSurface<TicketPlaceholderFacts>({
  id: TICKET_SURFACE_EVENTS.close,
  module: 'tickets',
  label: 'Ticket closing message',
  event: TICKET_SURFACE_EVENTS.close,
  audience: 'member_private',
  fields: [textField('closeConfirmation', 'Closing message')],
  definitions: closeDefinitions(),
  build: ticketLookup,
  samples: [CLOSE_SAMPLE],
});

export const TICKET_BLACKLIST_SURFACE = definePlaceholderSurface<TicketPlaceholderFacts>({
  id: TICKET_SURFACE_EVENTS.blacklist,
  module: 'tickets',
  label: 'Blacklist message',
  event: TICKET_SURFACE_EVENTS.blacklist,
  audience: 'member_private',
  fields: [textField('blacklistMessage', 'Blacklist message')],
  definitions: blacklistDefinitions(),
  build: ticketLookup,
  samples: [BLACKLIST_SAMPLE],
});

export const TICKET_RESPONSE_SURFACE = definePlaceholderSurface<TicketPlaceholderFacts>({
  id: TICKET_SURFACE_EVENTS.response,
  module: 'tickets',
  label: 'Quick response',
  event: TICKET_SURFACE_EVENTS.response,
  audience: 'member_private',
  fields: [textField('responses.*.content', 'Response text')],
  definitions: responseDefinitions(),
  build: ticketLookup,
  samples: [RESPONSE_SAMPLE],
});

export type TicketMessageSurface = PlaceholderSurface<TicketPlaceholderFacts>;

const SURFACE_LIST = [
  TICKET_NAME_SURFACE,
  TICKET_WELCOME_SURFACE,
  TICKET_CLOSE_SURFACE,
  TICKET_BLACKLIST_SURFACE,
  TICKET_RESPONSE_SURFACE,
] as const;

export const ticketsTemplates: ModuleTemplates = Object.freeze({
  surfaces: Object.freeze(Object.fromEntries(SURFACE_LIST.map((surface) => [surface.id, surface]))),
  collect: (config: unknown) =>
    SURFACE_LIST.flatMap((surface) => collectConfigTemplates(config, surface)),
});

function renderWith<F>(
  surface: PlaceholderSurface<F>,
  template: string,
  facts: F,
  now: number,
): string {
  return renderTemplate(template, surface.build(facts, { now }), {
    registry: surface.registry,
    field: surface.fields[0]?.kind ?? 'plain_text',
    event: surface.event,
    audience: surface.audience,
    now,
  }).output;
}

export function renderTicketChannelName(
  pattern: string,
  facts: TicketNameFacts,
  now: number,
): string {
  return sanitiseChannelName(renderWith(TICKET_NAME_SURFACE, pattern, facts, now));
}

export function renderTicketText(
  surface: TicketMessageSurface,
  template: string,
  facts: TicketPlaceholderFacts,
  now: number,
): string {
  return clipGraphemes(renderWith(surface, template, facts, now), TICKET_TEXT_MAX);
}

export function renderTicketWelcome(
  template: string,
  facts: TicketPlaceholderFacts,
  now: number,
): string {
  return renderTicketText(TICKET_WELCOME_SURFACE, template, facts, now);
}

export function ticketSourcesFor(
  surface: Pick<PlaceholderSurface<unknown>, 'registry' | 'fields' | 'event' | 'audience'>,
  templates: Iterable<string>,
): TicketSources {
  const field = surface.fields[0]?.kind ?? 'plain_text';
  const context = { field, event: surface.event, audience: surface.audience };
  const sources: TicketSources = {
    owner: false,
    actor: false,
    server: false,
    bot: false,
    answers: false,
    participants: false,
  };

  for (const template of templates) {
    for (const token of parseTemplate(template, surface.registry).tokens) {
      if (token.kind !== 'placeholder' || token.canonical === null) continue;
      if (token.key !== token.canonical) continue;

      const resolution = surface.registry.resolve(token.key);
      if (resolution === undefined) continue;
      if (unavailableReason(resolution.definition, context) !== undefined) continue;
      if (isRestricted(resolution.definition, surface.audience)) continue;

      const key = resolution.canonical;
      const dot = key.indexOf('.');
      const namespace = dot === -1 ? key : key.slice(0, dot);
      const name = key.slice(dot + 1);
      const named = PROFILE_KEYS.has(name) || (field === 'plain_text' && name === 'mention');

      if (namespace === 'user' && named) sources.owner = true;
      if (namespace === 'actor' && named) sources.actor = true;
      if (namespace === 'server') sources.server = true;
      if (namespace === 'bot') sources.bot = true;
      if (key.startsWith(ANSWER_PREFIX)) sources.answers = true;
      if (key === 'ticket.participant_count') sources.participants = true;
    }
  }

  return sources;
}
