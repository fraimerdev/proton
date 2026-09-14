import {
  type BotFacts,
  type BuildEnv,
  botDefinitions,
  buildBotValues,
  buildServerValues,
  buildTimeValues,
  DISCORD_TEXT_LIMITS,
  definePlaceholderSurface,
  isHttpUrl,
  lookupFrom,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  type RenderResult,
  type ResolvedValue,
  renderTemplate,
  SAMPLE_BOT,
  SAMPLE_GIVEAWAY_WIN,
  SAMPLE_MEMBER,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  type ServerFacts,
  serverDefinitions,
  type TemplateFieldSpec,
  timeDefinitions,
  usedKeys,
  userDefinitions,
  placeholderValue as v,
} from '@proton/core/placeholders';

export const GIVEAWAY_WIN_EVENT = 'giveaways.win';

export const WIN_MESSAGE_PATH = 'winMessage';

export interface GiveawayWinFacts {
  giveaway: {
    title: string;
    prize: string;
    winnerIndex: number;
    winnerCount: number;
    endsAt: Date;
    messageUrl: string | null;
    hostId: string;
    claimDeadline: Date | null | undefined;
  };
  winner: { userId: string };
  server: ServerFacts | null;
  bot: BotFacts | null;
}

const GROUP = 'Giveaway';

const EXAMPLE_HOST = '100000000000000002';

const SNOWFLAKE = /^\d{17,20}$/;

const DATE_MS_MAX = 8_640_000_000_000_000;

const GIVEAWAY_DEFINITIONS: readonly PlaceholderDefinitionInput[] = [
  {
    key: 'giveaway.title',
    label: 'Giveaway title',
    description: 'The title the giveaway was posted under',
    group: GROUP,
    type: 'text',
    example: v.text(SAMPLE_GIVEAWAY_WIN.title),
  },
  {
    key: 'giveaway.prize',
    label: 'Prize',
    description: 'What this winner won. With several prizes, the one for their place in the draw.',
    group: GROUP,
    type: 'text',
    example: v.text(SAMPLE_GIVEAWAY_WIN.prize),
  },
  {
    key: 'giveaway.winner_count',
    label: 'Winners',
    description: 'How many winners this draw picked',
    group: GROUP,
    type: 'integer',
    example: v.integer(SAMPLE_GIVEAWAY_WIN.winnerCount),
  },
  {
    key: 'giveaway.winner_position',
    label: 'Winner number',
    description: "This winner's place in the draw, counting from 1",
    group: GROUP,
    type: 'integer',
    example: v.integer(SAMPLE_GIVEAWAY_WIN.winnerIndex + 1),
  },
  {
    key: 'giveaway.message_url',
    label: 'Giveaway link',
    description: 'A link to the giveaway message. Empty when the message is gone.',
    group: GROUP,
    type: 'url',
    example: v.url(SAMPLE_GIVEAWAY_WIN.messageUrl),
  },
  {
    key: 'giveaway.host',
    label: 'Host',
    description: 'The member who hosted the giveaway',
    group: GROUP,
    type: 'mention',
    example: v.user(EXAMPLE_HOST, 'Host'),
  },
  {
    key: 'giveaway.ended_at',
    label: 'Ended',
    description: 'When the giveaway ended',
    group: GROUP,
    type: 'datetime',
    example: v.datetime(SAMPLE_NOW),
  },
  {
    key: 'giveaway.claim_deadline',
    label: 'Claim by',
    description: 'When the prize has to be claimed by. Empty when winners do not need to claim.',
    group: GROUP,
    type: 'datetime',
    example: v.datetime(SAMPLE_GIVEAWAY_WIN.claimDeadline),
  },
];

const WINNER_KEYS: ReadonlySet<string> = new Set(['user.id', 'user.mention']);

const DEFINITIONS: readonly PlaceholderDefinitionInput[] = [
  ...GIVEAWAY_DEFINITIONS,
  ...userDefinitions('user', { member: false }).filter((definition) =>
    WINNER_KEYS.has(definition.key),
  ),
  ...serverDefinitions().filter((definition) => definition.key === 'server.name'),
  ...botDefinitions(),
  ...timeDefinitions(),
];

const FIELDS: readonly TemplateFieldSpec[] = [
  {
    path: WIN_MESSAGE_PATH,
    kind: 'discord_text',
    label: 'Message sent to winners',
    limit: DISCORD_TEXT_LIMITS.content,
  },
];

function moment(at: Date, what: string): ResolvedValue {
  const ms = at.getTime();
  return Number.isSafeInteger(ms) && Math.abs(ms) <= DATE_MS_MAX
    ? v.datetime(ms)
    : v.failed(`the time Proton holds for ${what} is not a date`);
}

function count(value: number, what: string): ResolvedValue {
  return Number.isSafeInteger(value) && value >= 0
    ? v.integer(value)
    : v.failed(`the ${what} Proton holds is not a whole number`);
}

function member(id: string, who: string): ResolvedValue {
  return SNOWFLAKE.test(id)
    ? v.user(id)
    : v.failed(`the ${who} id Proton holds is not a Discord id`);
}

function messageLink(url: string | null): ResolvedValue {
  if (url === null) return v.notSet('the giveaway message is gone');

  return isHttpUrl(url)
    ? v.url(url)
    : v.failed('the giveaway link Proton holds is not an http or https address');
}

function claimValue(deadline: Date | null | undefined): ResolvedValue {
  if (deadline === undefined) {
    return v.unavailable('Proton could not read when this prize has to be claimed by');
  }

  return deadline === null
    ? v.notSet('winners of this giveaway do not need to claim')
    : moment(deadline, 'the claim deadline');
}

function winLookup(facts: GiveawayWinFacts, env: BuildEnv): PlaceholderLookup {
  const { giveaway, winner } = facts;

  return lookupFrom({
    ...buildServerValues(facts.server),
    ...buildBotValues(facts.bot),
    ...buildTimeValues(env.now),
    'user.id': v.text(winner.userId),
    'user.mention': member(winner.userId, 'winner'),
    'giveaway.title': v.text(giveaway.title),
    'giveaway.prize': v.text(giveaway.prize),
    'giveaway.winner_count': count(giveaway.winnerCount, 'winner count'),
    'giveaway.winner_position': count(giveaway.winnerIndex + 1, 'winner number'),
    'giveaway.message_url': messageLink(giveaway.messageUrl),
    'giveaway.host': member(giveaway.hostId, 'host'),
    'giveaway.ended_at': moment(giveaway.endsAt, 'when this giveaway ended'),
    'giveaway.claim_deadline': claimValue(giveaway.claimDeadline),
  });
}

const SAMPLE_FACTS: GiveawayWinFacts = Object.freeze({
  giveaway: Object.freeze({
    title: SAMPLE_GIVEAWAY_WIN.title,
    prize: SAMPLE_GIVEAWAY_WIN.prize,
    winnerIndex: SAMPLE_GIVEAWAY_WIN.winnerIndex,
    winnerCount: SAMPLE_GIVEAWAY_WIN.winnerCount,
    endsAt: new Date(SAMPLE_NOW),
    messageUrl: SAMPLE_GIVEAWAY_WIN.messageUrl,
    hostId: EXAMPLE_HOST,
    claimDeadline: new Date(SAMPLE_GIVEAWAY_WIN.claimDeadline),
  }),
  winner: Object.freeze({ userId: SAMPLE_MEMBER.user.id }),
  server: SAMPLE_SERVER,
  bot: SAMPLE_BOT,
});

export const GIVEAWAY_WIN_SURFACE: PlaceholderSurface<GiveawayWinFacts> =
  definePlaceholderSurface<GiveawayWinFacts>({
    id: 'giveaways.win_dm',
    module: 'giveaways',
    label: 'Winner message',
    event: GIVEAWAY_WIN_EVENT,
    audience: 'member_private',
    fields: FIELDS,
    definitions: DEFINITIONS,
    build: winLookup,
    samples: [
      {
        id: 'giveaway_winner',
        label: 'Sample: Fraimer winning Nitro Classic in Proton HQ',
        facts: SAMPLE_FACTS,
      },
    ],
  });

export function winMessageKeys(template: string): Set<string> {
  return usedKeys(GIVEAWAY_WIN_SURFACE, [template], { allowedOnly: true });
}

export function renderWinMessage(
  template: string,
  facts: GiveawayWinFacts,
  now: number,
): RenderResult {
  return renderTemplate(template, GIVEAWAY_WIN_SURFACE.build(facts, { now }), {
    registry: GIVEAWAY_WIN_SURFACE.registry,
    field: 'discord_text',
    event: GIVEAWAY_WIN_SURFACE.event,
    audience: GIVEAWAY_WIN_SURFACE.audience,
    now,
  });
}
