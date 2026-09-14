import {
  type BotFacts,
  type BuildEnv,
  botDefinitions,
  buildBotValues,
  buildChannelValues,
  buildServerValues,
  buildTimeValues,
  buildUserValues,
  type ChannelFacts,
  channelDefinitions,
  collectConfigTemplates,
  definePlaceholderSurface,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type MemberFacts,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderValue,
  type ResolvedValue,
  SAMPLE_BOT,
  SAMPLE_LEVEL_UP,
  SAMPLE_MEMBER,
  SAMPLE_SERVER,
  type ServerFacts,
  SHARED_PINGS,
  type SurfaceSample,
  serverDefinitions,
  timeDefinitions,
  typeOf,
  type UserFacts,
  userDefinitions,
  placeholderValue as v,
  withAliases,
} from '@proton/core/placeholders';
import { levelProgress, MAX_LEVEL } from './curve.ts';

export const LEVEL_UP_BASE_PATH = 'levelUpMessage';

export interface LevelUpRank {
  rank: number;
  messages: number;
  voiceSeconds: number;
}

export interface LevelUpRewards {
  granted: readonly string[];
  revoked: readonly string[];
}

export interface LevelUpPlaceholderFacts {
  userId: string;
  user: UserFacts | null;
  member: MemberFacts | 'unavailable';
  level: number;
  previousLevel: number;
  xp: number;
  gained?: number | undefined;
  source: 'message' | 'voice' | 'admin';
  rank?: LevelUpRank | null | undefined;
  rankedMemberCount?: number | null | undefined;
  rewards?: LevelUpRewards | undefined;
  server: ServerFacts | null;
  originChannel?: ChannelFacts | undefined;
  destinationChannel: ChannelFacts;
  bot: BotFacts | null;
}

export const LEVEL_UP_RANK_KEYS: readonly string[] = [
  'level.rank',
  'level.messages',
  'level.voice_seconds',
];

export const LEVEL_UP_RANKED_COUNT_KEY = 'level.ranked_member_count';

const SNOWFLAKE = /^\d{17,20}$/;

const ROLE_PING_NOTE =
  "In message text these ping each role whenever this message's mention settings allow role pings, which is the default.";

type Entry = readonly [key: string, label: string, description: string, example: PlaceholderValue];

const LEVEL_ENTRIES: readonly Entry[] = [
  ['level.current', 'Level', 'The level they just reached', v.integer(5)],
  ['level.previous', 'Previous level', 'The level they had before this level-up', v.integer(4)],
  ['level.gained', 'Levels gained', 'How many levels this level-up jumped', v.integer(1)],
  ['level.next', 'Next level', 'The level after this one', v.integer(6)],
  [
    'level.is_max',
    'Is max level',
    'Yes when they have reached the highest level',
    v.boolean(false),
  ],
  ['xp.total', 'Total XP', 'Their XP in this server', v.integer(1234)],
  ['xp.into_level', 'XP into level', 'XP earned since reaching this level', v.integer(234)],
  ['xp.level_span', 'XP for this level', 'XP between this level and the next', v.integer(350)],
  ['xp.remaining', 'XP to next level', 'XP still needed for the next level', v.integer(116)],
  [
    'xp.progress_percent',
    'Progress',
    'How far they are towards the next level; 0 at the highest level',
    v.percent(66.86),
  ],
  [
    'xp.gained',
    'XP gained',
    'The XP that brought them to this level; empty after /xp set',
    v.integer(23),
  ],
  ['level.source', 'How they levelled', "'message', 'voice' or 'admin'", v.text('message')],
  ['level.rank', 'Rank', "Their place on this server's leaderboard", v.integer(12)],
  ['level.messages', 'Messages', 'How many of their messages have earned XP', v.integer(812)],
  [
    'level.voice_seconds',
    'Voice time',
    'How long they have earned XP in voice',
    v.duration(18_000_000),
  ],
  [
    LEVEL_UP_RANKED_COUNT_KEY,
    'Ranked members',
    'How many members of this server have any XP',
    v.integer(480),
  ],
  [
    'level.reward_roles',
    'Reward roles',
    `The reward roles just given, as mentions. ${ROLE_PING_NOTE}`,
    v.list('mention', [v.role('100000000000000021', 'Level 5')]),
  ],
  [
    'level.removed_roles',
    'Removed roles',
    `The reward roles just removed, as mentions. ${ROLE_PING_NOTE}`,
    v.list('mention', [v.role('100000000000000022', 'Level 1')]),
  ],
];

const ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['user.mention', ['user']],
  ['level.current', ['level']],
  ['xp.total', ['xp']],
]);

function levelUpDefinitions(): PlaceholderDefinitionInput[] {
  const own = LEVEL_ENTRIES.map(
    ([key, label, description, example]): PlaceholderDefinitionInput => ({
      key,
      label,
      description,
      group: 'Level',
      type: typeOf(example),
      example,
    }),
  );

  return [
    ...own,
    ...userDefinitions('user', { member: true }),
    ...serverDefinitions(),
    ...channelDefinitions('channel'),
    ...channelDefinitions('destination_channel'),
    ...botDefinitions(),
    ...timeDefinitions(),
  ].map((definition) => {
    const named = ALIASES.get(definition.key);
    return named === undefined ? definition : withAliases(definition, named);
  });
}

function whole(value: number, what: string): ResolvedValue {
  return Number.isSafeInteger(value)
    ? v.integer(value)
    : v.failed(`${what} Proton holds is not a whole number`);
}

function progressValues(xp: number): Record<string, ResolvedValue> {
  if (!Number.isSafeInteger(xp) || xp < 0) {
    const failed = v.failed('the XP Proton holds is not a whole number');
    return {
      'xp.into_level': failed,
      'xp.level_span': failed,
      'xp.remaining': failed,
      'xp.progress_percent': failed,
    };
  }

  const { into, span, remaining } = levelProgress(xp);

  return {
    'xp.into_level': v.integer(into),
    'xp.level_span': v.integer(span),
    'xp.remaining': v.integer(remaining),
    'xp.progress_percent': v.percent(span === 0 ? 0 : (into / span) * 100),
  };
}

function rankValues(rank: LevelUpRank | null | undefined): Record<string, ResolvedValue> {
  if (rank === undefined || rank === null) {
    const absent =
      rank === undefined
        ? v.unavailable("Proton did not read this member's leaderboard entry")
        : v.failed("Proton could not read this member's leaderboard entry");
    return { 'level.rank': absent, 'level.messages': absent, 'level.voice_seconds': absent };
  }

  const voiceMs = rank.voiceSeconds * 1000;

  return {
    'level.rank': whole(rank.rank, 'the rank'),
    'level.messages': whole(rank.messages, 'the message count'),
    'level.voice_seconds': Number.isSafeInteger(voiceMs)
      ? v.duration(voiceMs)
      : v.failed('the voice time Proton holds is not a whole number of seconds'),
  };
}

function rankedCountValue(count: number | null | undefined): ResolvedValue {
  if (count === undefined) return v.unavailable('Proton did not count the ranked members');
  if (count === null) return v.failed('Proton could not count the ranked members');
  return whole(count, 'the ranked member count');
}

function roleList(ids: readonly string[]): ResolvedValue {
  return v.list(
    'mention',
    ids.filter((id) => SNOWFLAKE.test(id)).map((id) => v.role(id)),
  );
}

function rewardValues(rewards: LevelUpRewards | undefined): Record<string, ResolvedValue> {
  if (rewards === undefined) {
    const absent = v.unavailable('Proton did not work out the reward roles for this level-up');
    return { 'level.reward_roles': absent, 'level.removed_roles': absent };
  }

  return {
    'level.reward_roles': roleList(rewards.granted),
    'level.removed_roles': roleList(rewards.revoked),
  };
}

function userValues(facts: LevelUpPlaceholderFacts, now: number): Record<string, ResolvedValue> {
  const values = buildUserValues('user', facts.user, facts.member, now);
  if (facts.user !== null) return values;

  values['user.id'] = v.text(facts.userId);
  values['user.mention'] = SNOWFLAKE.test(facts.userId)
    ? v.user(facts.userId)
    : v.failed('the id Proton holds for this member is not a Discord id');

  return values;
}

function levelUpLookup(facts: LevelUpPlaceholderFacts, env: BuildEnv): PlaceholderLookup {
  const guildId = facts.server?.id ?? '';

  return lookupFrom({
    ...userValues(facts, env.now),
    ...buildServerValues(facts.server),
    ...buildChannelValues('channel', facts.originChannel ?? null, guildId),
    ...buildChannelValues('destination_channel', facts.destinationChannel, guildId),
    ...buildBotValues(facts.bot),
    ...buildTimeValues(env.now),
    'level.current': whole(facts.level, 'the level'),
    'level.previous': whole(facts.previousLevel, 'the previous level'),
    'level.gained': whole(facts.level - facts.previousLevel, 'the level change'),
    'level.next': whole(Math.min(facts.level + 1, MAX_LEVEL), 'the next level'),
    'level.is_max': v.boolean(facts.level >= MAX_LEVEL),
    'xp.total': whole(facts.xp, 'the XP'),
    ...progressValues(facts.xp),
    'xp.gained':
      facts.gained === undefined
        ? v.unavailable('this level-up does not say how much XP brought it')
        : whole(facts.gained, 'the XP gained'),
    'level.source': v.text(facts.source),
    ...rankValues(facts.rank),
    [LEVEL_UP_RANKED_COUNT_KEY]: rankedCountValue(facts.rankedMemberCount),
    ...rewardValues(facts.rewards),
  });
}

const SAMPLE_CHANNEL: ChannelFacts = {
  id: '100000000000000040',
  name: 'general',
  type: 0,
  parentId: null,
};

const SAMPLE: SurfaceSample<LevelUpPlaceholderFacts> = {
  id: 'level_up',
  label: `Sample: ${SAMPLE_MEMBER.user.globalName ?? 'Fraimer'} reaching level ${SAMPLE_LEVEL_UP.level} in ${SAMPLE_SERVER.name ?? 'Proton HQ'}`,
  facts: {
    userId: SAMPLE_MEMBER.user.id,
    user: SAMPLE_MEMBER.user,
    member: SAMPLE_MEMBER.member,
    level: SAMPLE_LEVEL_UP.level,
    previousLevel: SAMPLE_LEVEL_UP.previous,
    xp: SAMPLE_LEVEL_UP.xp,
    gained: SAMPLE_LEVEL_UP.gained,
    source: SAMPLE_LEVEL_UP.source,
    rank: {
      rank: SAMPLE_LEVEL_UP.rank,
      messages: SAMPLE_LEVEL_UP.messages,
      voiceSeconds: SAMPLE_LEVEL_UP.voiceSeconds,
    },
    rankedMemberCount: SAMPLE_LEVEL_UP.rankedMemberCount,
    rewards: { granted: ['100000000000000021'], revoked: [] },
    server: SAMPLE_SERVER,
    originChannel: SAMPLE_CHANNEL,
    destinationChannel: SAMPLE_CHANNEL,
    bot: SAMPLE_BOT,
  },
};

export const LEVEL_UP_SURFACE = definePlaceholderSurface<LevelUpPlaceholderFacts>({
  id: 'leveling.level_up',
  module: 'leveling',
  label: 'Level-up announcement',
  event: 'leveling.level_up',
  audience: 'public',
  fields: MESSAGE_TEMPLATE_FIELDS.map((spec) => ({
    ...spec,
    path: `${LEVEL_UP_BASE_PATH}.${spec.path}`,
  })),
  definitions: levelUpDefinitions(),
  build: levelUpLookup,
  samples: [SAMPLE],
  pings: { ...SHARED_PINGS, 'level.reward_roles': 'roles', 'level.removed_roles': 'roles' },
});

export const levelingTemplates: ModuleTemplates = Object.freeze({
  surfaces: Object.freeze({ [LEVEL_UP_SURFACE.id]: LEVEL_UP_SURFACE }),
  collect: (config: unknown) => collectConfigTemplates(config, LEVEL_UP_SURFACE),
});
