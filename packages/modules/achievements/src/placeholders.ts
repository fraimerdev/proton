import { TIER_LABELS } from '@proton/cards/design';
import {
  type CustomIdFor,
  type DiscordMessageBody,
  type TierId,
  toDiscordMessage,
} from '@proton/core';
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
  collectMessageSites,
  definePlaceholderSurface,
  lookupFrom,
  MESSAGE_TEMPLATE_FIELDS,
  type MemberFacts,
  type MessageRender,
  type ModuleTemplates,
  type PlaceholderDefinitionInput,
  type PlaceholderLookup,
  type PlaceholderSurface,
  type PlaceholderValue,
  type ResolvedValue,
  renderMessageTemplate,
  SAMPLE_ACHIEVEMENT,
  SAMPLE_BOT,
  SAMPLE_NOW,
  SAMPLE_SERVER,
  type ServerFacts,
  SHARED_PINGS,
  type SurfaceSample,
  serverDefinitions,
  type TemplateFieldSpec,
  timeDefinitions,
  typeOf,
  type UserFacts,
  usedKeys,
  userDefinitions,
  placeholderValue as v,
  withAliases,
  withAvailability,
} from '@proton/core/placeholders';
import {
  type Achievement,
  type AchievementKind,
  type AchievementsConfig,
  type ANNOUNCE_TARGETS,
  type AnnouncementMessage,
  achievementSchema,
  achievementsDefaultConfig,
  type Requirement,
  TIERED_IDS,
  type Tier,
} from './config.ts';
import { describeRequirement, earnedTierIds, joinAnd, nextTier, tierRank } from './evaluate.ts';
import { type RewardKind, triggerOf } from './triggers.ts';

export const ACHIEVEMENT_MESSAGE_KINDS = [
  'unlocked',
  'unlocked_dm',
  'almost_there',
  'almost_there_dm',
] as const;

export type AchievementMessageKind = (typeof ACHIEVEMENT_MESSAGE_KINDS)[number];

export type AnnounceTarget = (typeof ANNOUNCE_TARGETS)[number];

export const ANNOUNCEMENT_BASE_PATH = 'announcement.message';

export const ALMOST_THERE_BASE_PATH = 'almostThere.message';

export const EARNED_COUNT_KEY = 'achievement.earned_count';

export const BADGE_FILENAME = 'badge.png';

export interface RewardFact {
  kind: RewardKind;
  roleId?: string | undefined;
  amount?: number | undefined;
  name?: string | undefined;
}

export interface RewardFacts {
  granted: readonly RewardFact[];
  pending: readonly RewardFact[];
  failed: readonly RewardFact[];
}

export interface RequirementFact {
  trigger: string;
  label: string;
  current: number;
  target: number;
  unit: { one: string; many: string };
}

export interface AchievementPlaceholderFacts {
  userId: string;
  user: UserFacts | null;
  member: MemberFacts | 'unavailable';
  server: ServerFacts | null;
  bot: BotFacts | null;
  originChannel: ChannelFacts | null;
  destinationChannel: ChannelFacts | null;
  achievement: {
    id: string;
    name: string;
    description: string;
    kind: AchievementKind;
    tierCount: number;
  };
  tier: TierId;
  tiersUnlocked: readonly TierId[];
  requirements: readonly RequirementFact[];
  rewards: RewardFacts | null;
  unlockedAt: number | null;
  deadline: number | null;
  earnedCount: number | null;
  timeZone: string;
}

const EVENTS: Readonly<Record<AchievementMessageKind, string>> = {
  unlocked: 'achievements.unlocked',
  unlocked_dm: 'achievements.unlocked_dm',
  almost_there: 'achievements.almost_there',
  almost_there_dm: 'achievements.almost_there_dm',
};

const DM_KINDS: ReadonlySet<AchievementMessageKind> = new Set(['unlocked_dm', 'almost_there_dm']);

const UNLOCK_EVENTS = [EVENTS.unlocked, EVENTS.unlocked_dm];

const CHANNEL_EVENTS = [EVENTS.unlocked, EVENTS.almost_there];

const SNOWFLAKE = /^\d{17,20}$/;

const COUNT = new Intl.NumberFormat('en-GB');

const TIER_BADGES: Readonly<Record<TierId, string>> = {
  single: '🏅',
  bronze: '🥉',
  silver: '🥈',
  gold: '🥇',
  diamond: '💎',
};

const ROLE_PING_NOTE =
  'In message text, these ping each role if role pings are on for this message. They’re off by ' +
  'default.';

type Entry = readonly [key: string, label: string, description: string, example: PlaceholderValue];

const ACHIEVEMENT_ENTRIES: readonly Entry[] = [
  ['achievement.name', 'Achievement', 'The achievement’s name', v.text('Chatterbox')],
  [
    'achievement.description',
    'Description',
    'The achievement’s description, with its formatting; empty when it has none',
    v.markdown('Keep the conversation going in Proton HQ.'),
  ],
  [
    'achievement.tier',
    'Tier',
    'The tier this message is about, such as Gold (the one just earned, or the one they’re ' +
      'close to). Earned for an achievement without tiers',
    v.text('Gold'),
  ],
  [
    'achievement.tier_label',
    'Tier in brackets',
    'The tier in brackets, such as (Gold); empty for an achievement without tiers',
    v.text('(Gold)'),
  ],
  [
    'achievement.tier_number',
    'Tier number',
    'Which tier this is, from 1 for Bronze to 4 for Diamond; 1 for an achievement without tiers',
    v.integer(3),
  ],
  [
    'achievement.tier_count',
    'Number of tiers',
    'How many tiers the achievement has; 1 for an achievement without tiers',
    v.integer(4),
  ],
  [
    'achievement.badge',
    'Tier medal',
    'A medal for the tier: 🥉 Bronze, 🥈 Silver, 🥇 Gold, 💎 Diamond, or 🏅 without tiers',
    v.text('🥇'),
  ],
  [
    'achievement.deadline',
    'Deadline',
    'When the achievement stops counting; empty when it has no deadline',
    v.datetime(SAMPLE_NOW + 30 * 24 * 60 * 60 * 1000),
  ],
  [
    EARNED_COUNT_KEY,
    'Achievements held',
    'How many of this server’s achievements they hold, this one included',
    v.integer(5),
  ],
  [
    'requirement.summary',
    'Requirements',
    'What the tier asks for, such as Send 1,000 messages',
    v.text('Send 1,000 messages'),
  ],
  [
    'progress.current',
    'Progress',
    'Their count for the requirement furthest from done',
    v.integer(1000),
  ],
  ['progress.target', 'Target', 'The tier’s target for that requirement', v.integer(1000)],
  [
    'progress.remaining',
    'Still to go',
    'How much of that requirement is left; 0 once it is done',
    v.integer(0),
  ],
  [
    'progress.percent',
    'Progress percent',
    'How far they are towards the tier, going by the requirement furthest from done',
    v.percent(100),
  ],
  ['progress.unit', 'Unit', 'What that requirement counts, such as messages', v.text('messages')],
  [
    'progress.summary',
    'Progress summary',
    'Every requirement as progress and target, such as 320 / 500 messages, 40 / 60 voice minutes',
    v.text('1,000 / 1,000 messages'),
  ],
];

const UNLOCK_ENTRIES: readonly Entry[] = [
  [
    'achievement.tiers_unlocked',
    'Tiers held',
    'Every tier they hold after this unlock, such as Bronze, Silver and Gold',
    v.text('Bronze, Silver and Gold'),
  ],
  ['achievement.unlocked_at', 'Earned at', 'When they earned it', v.datetime(SAMPLE_NOW)],
  [
    'rewards.granted_roles',
    'Roles given',
    `The roles given for this unlock, as mentions. ${ROLE_PING_NOTE}`,
    v.list('mention', [v.role('100000000000000021', 'Regular')]),
  ],
  [
    'rewards.pending_roles',
    'Roles on their way',
    `The roles Proton is still giving for this unlock, as mentions. ${ROLE_PING_NOTE}`,
    v.list('mention', [v.role('100000000000000021', 'Regular')]),
  ],
  [
    'rewards.failed_roles',
    'Roles not given',
    `The roles Proton could not give for this unlock, as mentions. ${ROLE_PING_NOTE}`,
    v.list('mention', [v.role('100000000000000021', 'Regular')]),
  ],
  [
    'rewards.granted_xp',
    'XP given',
    'The XP Leveling confirmed giving for this unlock; 0 when none',
    v.integer(250),
  ],
  [
    'rewards.pending_xp',
    'XP on its way',
    'The XP requested from Leveling that it hasn’t confirmed yet; 0 when none',
    v.integer(0),
  ],
];

const SUMMARY_DEFINITION: PlaceholderDefinitionInput = {
  key: 'rewards.summary',
  label: 'Rewards',
  description:
    'The rewards in one line, such as @Regular and 250 XP given; 50 XP still on its way. A ' +
    'reward that failed is left out; {rewards.failed_roles} names failed roles. Message text only',
  group: 'Achievement',
  type: 'markdown',
  example: v.markdown('<@&100000000000000021> and 250 XP given'),
  availability: { fields: ['discord_text'], events: UNLOCK_EVENTS },
};

function defined([key, label, description, example]: Entry): PlaceholderDefinitionInput {
  return { key, label, description, group: 'Achievement', type: typeOf(example), example };
}

function achievementDefinitions(): PlaceholderDefinitionInput[] {
  return [
    ...ACHIEVEMENT_ENTRIES.map(defined),
    ...UNLOCK_ENTRIES.map((entry) => withAvailability(defined(entry), UNLOCK_EVENTS)),
    SUMMARY_DEFINITION,
    ...userDefinitions('user', { member: true }).map((definition) =>
      definition.key === 'user.mention' ? withAliases(definition, ['user']) : definition,
    ),
    ...serverDefinitions(),
    ...channelDefinitions('channel'),
    ...channelDefinitions('destination_channel').map((definition) =>
      withAvailability(definition, CHANNEL_EVENTS),
    ),
    ...botDefinitions(),
    ...timeDefinitions(),
  ];
}

const CHANNEL_KEYS: readonly string[] = channelDefinitions('channel').map(({ key }) => key);

function whole(value: number, what: string): ResolvedValue {
  return Number.isSafeInteger(value)
    ? v.integer(value)
    : v.failed(`${what} Proton holds is not a whole number`);
}

function moment(value: number, what: string): ResolvedValue {
  return Number.isSafeInteger(value)
    ? v.datetime(value)
    : v.failed(`${what} Proton holds is not a whole number of milliseconds`);
}

function count(value: number): string {
  return COUNT.format(value);
}

function noun(unit: { one: string; many: string }, target: number): string {
  return target === 1 ? unit.one : unit.many;
}

function userValues(
  facts: AchievementPlaceholderFacts,
  now: number,
): Record<string, ResolvedValue> {
  const values = buildUserValues('user', facts.user, facts.member, now);
  if (facts.user !== null) return values;

  values['user.id'] = v.text(facts.userId);
  values['user.mention'] = SNOWFLAKE.test(facts.userId)
    ? v.user(facts.userId)
    : v.failed('the ID Proton holds for this member isn’t a Discord ID');

  return values;
}

function originValues(
  channel: ChannelFacts | null,
  guildId: string,
): Record<string, ResolvedValue> {
  if (channel !== null) return buildChannelValues('channel', channel, guildId);

  const none = v.notSet('this was earned outside a channel');
  return Object.fromEntries(CHANNEL_KEYS.map((key) => [key, none]));
}

function byRank(ids: readonly TierId[]): TierId[] {
  return [...new Set(ids)].sort((a, b) => tierRank(a) - tierRank(b));
}

function tierNumber(tier: TierId): number {
  return tier === 'single' ? 1 : TIERED_IDS.indexOf(tier) + 1;
}

function achievementValues(facts: AchievementPlaceholderFacts): Record<string, ResolvedValue> {
  const { achievement, tier } = facts;
  const held = byRank(facts.tiersUnlocked);

  return {
    'achievement.name': v.text(achievement.name),
    'achievement.description': v.markdown(achievement.description),
    'achievement.tier': v.text(TIER_LABELS[tier]),
    'achievement.tier_label': v.text(tier === 'single' ? '' : `(${TIER_LABELS[tier]})`),
    'achievement.tier_number': v.integer(tierNumber(tier)),
    'achievement.tier_count': whole(achievement.tierCount, 'the number of tiers'),
    'achievement.badge': v.text(TIER_BADGES[tier]),
    'achievement.tiers_unlocked':
      held.length === 0 ? v.notSet() : v.text(joinAnd(held.map((id) => TIER_LABELS[id]))),
    'achievement.unlocked_at':
      facts.unlockedAt === null
        ? v.unavailable('this message is not about an unlock')
        : moment(facts.unlockedAt, 'the unlock time'),
    'achievement.deadline':
      facts.deadline === null
        ? v.notSet('this achievement has no deadline')
        : moment(facts.deadline, 'the deadline'),
    [EARNED_COUNT_KEY]:
      facts.earnedCount === null
        ? v.unavailable('Proton did not count the achievements they hold')
        : whole(facts.earnedCount, 'the achievement count'),
  };
}

function ratioOf(requirement: RequirementFact): number {
  if (requirement.target <= 0) return 1;
  return Math.min(1, Math.max(0, requirement.current) / requirement.target);
}

function sentence(label: string, index: number): string {
  return index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

function progressValues(requirements: readonly RequirementFact[]): Record<string, ResolvedValue> {
  const furthest = requirements.reduce<RequirementFact | undefined>(
    (worst, requirement) =>
      worst === undefined || ratioOf(requirement) < ratioOf(worst) ? requirement : worst,
    undefined,
  );

  if (furthest === undefined) {
    const absent = v.unavailable('this achievement has no requirement Proton could read');
    return {
      'requirement.summary': absent,
      'progress.current': absent,
      'progress.target': absent,
      'progress.remaining': absent,
      'progress.percent': absent,
      'progress.unit': absent,
      'progress.summary': absent,
    };
  }

  return {
    'requirement.summary': v.text(joinAnd(requirements.map(({ label }, i) => sentence(label, i)))),
    'progress.current': whole(furthest.current, 'the progress'),
    'progress.target': whole(furthest.target, 'the target'),
    'progress.remaining': whole(Math.max(0, furthest.target - furthest.current), 'the remainder'),
    'progress.percent': v.percent(Math.floor(ratioOf(furthest) * 100 + 1e-9)),
    'progress.unit': v.text(noun(furthest.unit, furthest.target)),
    'progress.summary': v.text(
      requirements
        .map(
          ({ current, target, unit }) =>
            `${count(current)} / ${count(target)} ${noun(unit, target)}`,
        )
        .join(', '),
    ),
  };
}

function rolesOf(rewards: readonly RewardFact[]): RewardFact[] {
  return rewards.filter(
    (reward) =>
      reward.kind === 'add_role' && reward.roleId !== undefined && SNOWFLAKE.test(reward.roleId),
  );
}

function removalsOf(rewards: readonly RewardFact[]): RewardFact[] {
  return rewards.filter(
    (reward) =>
      reward.kind === 'remove_role' && reward.roleId !== undefined && SNOWFLAKE.test(reward.roleId),
  );
}

function xpOf(rewards: readonly RewardFact[]): number {
  return rewards.reduce(
    (total, reward) =>
      reward.kind === 'xp' && Number.isSafeInteger(reward.amount)
        ? total + (reward.amount ?? 0)
        : total,
    0,
  );
}

function roleList(rewards: readonly RewardFact[]): ResolvedValue {
  return v.list(
    'mention',
    rolesOf(rewards).map((reward) => v.role(reward.roleId ?? '', reward.name)),
  );
}

function markup(rewards: readonly RewardFact[]): string[] {
  return rewards.map((reward) => `<@&${reward.roleId ?? ''}>`);
}

function withXp(parts: string[], xp: number): string[] {
  return xp > 0 ? [...parts, `${count(xp)} XP`] : parts;
}

function rewardSummary(rewards: RewardFacts): ResolvedValue {
  const given = withXp(markup(rolesOf(rewards.granted)), xpOf(rewards.granted));
  const removed = markup(removalsOf(rewards.granted));
  const coming = withXp(markup(rolesOf(rewards.pending)), xpOf(rewards.pending));
  const leaving = markup(removalsOf(rewards.pending));

  const clauses = [
    ...(given.length > 0 ? [`${joinAnd(given)} given`] : []),
    ...(removed.length > 0 ? [`${joinAnd(removed)} removed`] : []),
    ...(coming.length > 0
      ? [`${joinAnd(coming)} still on ${coming.length === 1 ? 'its' : 'their'} way`]
      : []),
    ...(leaving.length > 0 ? [`${joinAnd(leaving)} still to be removed`] : []),
  ];

  return clauses.length === 0
    ? v.notSet('no reward was given for this unlock')
    : v.markdown(clauses.join('; '));
}

function rewardValues(rewards: RewardFacts | null): Record<string, ResolvedValue> {
  if (rewards === null) {
    const absent = v.unavailable('Proton did not work out the rewards for this unlock');
    return {
      'rewards.granted_roles': absent,
      'rewards.pending_roles': absent,
      'rewards.failed_roles': absent,
      'rewards.granted_xp': absent,
      'rewards.pending_xp': absent,
      'rewards.summary': absent,
    };
  }

  return {
    'rewards.granted_roles': roleList(rewards.granted),
    'rewards.pending_roles': roleList(rewards.pending),
    'rewards.failed_roles': roleList(rewards.failed),
    'rewards.granted_xp': v.integer(xpOf(rewards.granted)),
    'rewards.pending_xp': v.integer(xpOf(rewards.pending)),
    'rewards.summary': rewardSummary(rewards),
  };
}

function achievementLookup(facts: AchievementPlaceholderFacts, env: BuildEnv): PlaceholderLookup {
  const guildId = facts.server?.id ?? '';

  return lookupFrom({
    ...userValues(facts, env.now),
    ...buildServerValues(facts.server),
    ...originValues(facts.originChannel, guildId),
    ...buildChannelValues('destination_channel', facts.destinationChannel, guildId),
    ...buildBotValues(facts.bot),
    ...buildTimeValues(env.now),
    ...achievementValues(facts),
    ...progressValues(facts.requirements),
    ...rewardValues(facts.rewards),
  });
}

export const REWARD_PREVIEWS = ['given', 'pending', 'failed'] as const;

export type RewardPreview = (typeof REWARD_PREVIEWS)[number];

export interface PreviewSubject {
  userId: string;
  user: UserFacts | null;
  member: MemberFacts | 'unavailable';
}

export interface PreviewInput {
  kind: AchievementMessageKind;
  now: number;
  tier?: TierId | undefined;
  values?: Readonly<Record<string, number>> | undefined;
  percent?: number | undefined;
  rewards?: RewardPreview | undefined;
  roleNames?: Readonly<Record<string, string>> | undefined;
  subject?: PreviewSubject | undefined;
  server?: ServerFacts | null | undefined;
  bot?: BotFacts | null | undefined;
  originChannel?: ChannelFacts | null | undefined;
  destinationChannel?: ChannelFacts | null | undefined;
  earnedCount?: number | null | undefined;
}

const SAMPLE_CHANNEL: ChannelFacts = {
  id: '100000000000000040',
  name: 'general',
  type: 0,
  parentId: null,
};

const [SAMPLE_REQUIREMENT] = SAMPLE_ACHIEVEMENT.requirements;

const SAMPLE_REQUIREMENT_ID = 'messages';

const SAMPLE_TARGETS: Readonly<Record<string, number>> = {
  bronze: 50,
  silver: 250,
  [SAMPLE_ACHIEVEMENT.tier]: SAMPLE_REQUIREMENT?.target ?? 1000,
  [SAMPLE_ACHIEVEMENT.next.tier]: SAMPLE_ACHIEVEMENT.next.target,
};

export const SAMPLE_DEFINITION: Achievement = achievementSchema.parse({
  id: SAMPLE_ACHIEVEMENT.achievement.id,
  name: SAMPLE_ACHIEVEMENT.achievement.name,
  description: SAMPLE_ACHIEVEMENT.achievement.description,
  status: 'active',
  badge: { shape: 'circle', icon: 'chat' },
  kind: SAMPLE_ACHIEVEMENT.achievement.kind,
  requirements: [{ id: SAMPLE_REQUIREMENT_ID, trigger: 'messages.sent' }],
  tiers: TIERED_IDS.map((id) => ({
    id,
    targets: { [SAMPLE_REQUIREMENT_ID]: SAMPLE_TARGETS[id] ?? 1 },
    rewards:
      id === SAMPLE_ACHIEVEMENT.tier
        ? [
            ...SAMPLE_ACHIEVEMENT.rewards.granted,
            ...SAMPLE_ACHIEVEMENT.rewards.pending,
            ...SAMPLE_ACHIEVEMENT.rewards.failed,
          ]
        : [],
  })),
  almostThere: { enabled: true, percent: 80 },
});

const SAMPLE_ROLE_NAMES: Readonly<Record<string, string>> = {
  [SAMPLE_ACHIEVEMENT.rewardRole.id]: SAMPLE_ACHIEVEMENT.rewardRole.name,
};

function tiersOf(achievement: Achievement): Tier[] {
  return [...achievement.tiers].sort((a, b) => tierRank(a.id) - tierRank(b.id));
}

export function closestTier(achievement: Achievement, wanted: TierId): Tier | undefined {
  const tiers = tiersOf(achievement);
  return tiers.filter((tier) => tierRank(tier.id) <= tierRank(wanted)).at(-1) ?? tiers[0];
}

export function isUnlockKind(kind: AchievementMessageKind): boolean {
  return kind === 'unlocked' || kind === 'unlocked_dm';
}

export function isDirectMessageKind(kind: AchievementMessageKind): boolean {
  return DM_KINDS.has(kind);
}

function defaultTier(
  achievement: Achievement,
  sample: boolean,
  unlock: boolean,
  values: Readonly<Record<string, number>> | undefined,
): TierId | undefined {
  if (sample) return unlock ? SAMPLE_ACHIEVEMENT.tier : SAMPLE_ACHIEVEMENT.next.tier;
  if (values === undefined) return tiersOf(achievement)[0]?.id;

  const earned = earnedTierIds(achievement, values);
  if (unlock) return earned.at(-1) ?? tiersOf(achievement)[0]?.id;

  return nextTier(achievement, values, earned)?.tier ?? tiersOf(achievement).at(-1)?.id;
}

function instant(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function rewardFacts(
  tier: Tier,
  state: RewardPreview,
  names: Readonly<Record<string, string>>,
): RewardFacts {
  const facts = tier.rewards.map((reward): RewardFact => {
    if (reward.kind === 'xp') return { kind: 'xp', amount: reward.amount };
    const name = Object.hasOwn(names, reward.roleId) ? names[reward.roleId] : undefined;
    return { kind: reward.kind, roleId: reward.roleId, ...(name === undefined ? {} : { name }) };
  });

  return {
    granted: state === 'given' ? facts : [],
    pending: state === 'pending' ? facts : [],
    failed: state === 'failed' ? facts : [],
  };
}

export function requirementFact(
  requirement: Requirement,
  target: number,
  current: number,
  nameOf?: (achievementId: string) => string | undefined,
): RequirementFact {
  return {
    trigger: requirement.trigger,
    label: describeRequirement(requirement, target, 'en-GB', nameOf),
    current,
    target,
    unit: triggerOf(requirement.trigger).unit,
  };
}

function orDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export function previewFacts(
  config: AchievementsConfig,
  achievement: Achievement | null,
  input: PreviewInput,
): AchievementPlaceholderFacts {
  const sample = achievement === null;
  const definition = achievement ?? SAMPLE_DEFINITION;
  const unlock = isUnlockKind(input.kind);
  const tiers = tiersOf(definition);
  const wanted = input.tier ?? defaultTier(definition, sample, unlock, input.values) ?? 'single';
  const tier = closestTier(definition, wanted) ?? { id: wanted, targets: {}, rewards: [] };
  const percent = Math.min(100, Math.max(0, input.percent ?? definition.almostThere.percent));

  const nameOf = (id: string): string | undefined =>
    config.achievements.find((candidate) => candidate.id === id)?.name;

  const requirements = definition.requirements.map((requirement) => {
    const target = tier.targets[requirement.id] ?? 0;
    const given = input.values?.[requirement.id];
    const current = unlock
      ? Math.max(given ?? target, target)
      : Math.max(0, given ?? Math.floor((target * percent) / 100));

    return requirementFact(requirement, target, current, nameOf);
  });

  const subject = input.subject ?? {
    userId: SAMPLE_ACHIEVEMENT.member.user.id,
    user: SAMPLE_ACHIEVEMENT.member.user,
    member: SAMPLE_ACHIEVEMENT.member.member,
  };

  const names = { ...(sample ? SAMPLE_ROLE_NAMES : {}), ...(input.roleNames ?? {}) };

  return {
    userId: subject.userId,
    user: subject.user,
    member: subject.member,
    server: orDefault(input.server, SAMPLE_SERVER),
    bot: orDefault(input.bot, SAMPLE_BOT),
    originChannel: orDefault(input.originChannel, SAMPLE_CHANNEL),
    destinationChannel: isDirectMessageKind(input.kind)
      ? null
      : orDefault(input.destinationChannel, SAMPLE_CHANNEL),
    achievement: {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      kind: definition.kind,
      tierCount: tiers.length,
    },
    tier: tier.id,
    tiersUnlocked: tiers
      .map(({ id }) => id)
      .filter((id) =>
        unlock ? tierRank(id) <= tierRank(tier.id) : tierRank(id) < tierRank(tier.id),
      ),
    requirements,
    rewards: unlock ? rewardFacts(tier, input.rewards ?? 'given', names) : null,
    unlockedAt: unlock ? input.now : null,
    deadline: instant(definition.endsAt),
    earnedCount: orDefault(input.earnedCount, SAMPLE_ACHIEVEMENT.earnedCount),
    timeZone: config.timezone,
  };
}

function prefixed(base: string): TemplateFieldSpec[] {
  return MESSAGE_TEMPLATE_FIELDS.map((spec) => ({ ...spec, path: `${base}.${spec.path}` }));
}

const UNLOCK_FIELDS: readonly TemplateFieldSpec[] = [
  ...prefixed(ANNOUNCEMENT_BASE_PATH),
  ...prefixed('achievements.*.announcement.message'),
];

const ALMOST_THERE_FIELDS: readonly TemplateFieldSpec[] = prefixed(ALMOST_THERE_BASE_PATH);

const SURFACE_LABELS: Readonly<Record<AchievementMessageKind, string>> = {
  unlocked: 'Unlock announcement',
  unlocked_dm: 'Unlock DM',
  almost_there: 'Almost there message',
  almost_there_dm: 'Almost there DM',
};

const SAMPLE_NAME = SAMPLE_ACHIEVEMENT.member.user.globalName ?? 'Fraimer';

function sampleFor(kind: AchievementMessageKind): SurfaceSample<AchievementPlaceholderFacts> {
  const facts = previewFacts(achievementsDefaultConfig, null, { kind, now: SAMPLE_NOW });
  const what = `${facts.achievement.name} (${TIER_LABELS[facts.tier]})`;

  return {
    id: 'achievement',
    label: isUnlockKind(kind)
      ? `Sample: ${SAMPLE_NAME} earning ${what} in ${SAMPLE_SERVER.name ?? 'Proton HQ'}`
      : `Sample: ${SAMPLE_NAME} close to ${what} in ${SAMPLE_SERVER.name ?? 'Proton HQ'}`,
    facts,
  };
}

const CHANNEL_PINGS = {
  ...SHARED_PINGS,
  'rewards.granted_roles': 'roles',
  'rewards.pending_roles': 'roles',
  'rewards.failed_roles': 'roles',
} as const;

function defineSurface(
  kind: AchievementMessageKind,
): PlaceholderSurface<AchievementPlaceholderFacts> {
  return definePlaceholderSurface<AchievementPlaceholderFacts>({
    id: EVENTS[kind],
    module: 'achievements',
    label: SURFACE_LABELS[kind],
    event: EVENTS[kind],
    audience: 'public',
    fields: isUnlockKind(kind) ? UNLOCK_FIELDS : ALMOST_THERE_FIELDS,
    definitions: achievementDefinitions(),
    build: achievementLookup,
    samples: [sampleFor(kind)],
    // A direct message is sent with every ping off, so a ping warning there would never be true.
    pings: isDirectMessageKind(kind) ? {} : CHANNEL_PINGS,
  });
}

export const ACHIEVEMENT_UNLOCKED_SURFACE = defineSurface('unlocked');

export const ACHIEVEMENT_UNLOCKED_DM_SURFACE = defineSurface('unlocked_dm');

export const ACHIEVEMENT_ALMOST_THERE_SURFACE = defineSurface('almost_there');

export const ACHIEVEMENT_ALMOST_THERE_DM_SURFACE = defineSurface('almost_there_dm');

export const ACHIEVEMENT_SURFACES: Readonly<
  Record<AchievementMessageKind, PlaceholderSurface<AchievementPlaceholderFacts>>
> = Object.freeze({
  unlocked: ACHIEVEMENT_UNLOCKED_SURFACE,
  unlocked_dm: ACHIEVEMENT_UNLOCKED_DM_SURFACE,
  almost_there: ACHIEVEMENT_ALMOST_THERE_SURFACE,
  almost_there_dm: ACHIEVEMENT_ALMOST_THERE_DM_SURFACE,
});

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function own(value: Record<string, unknown> | null, key: string): unknown {
  return value !== null && Object.hasOwn(value, key) ? value[key] : undefined;
}

function destinationOf(settings: unknown): unknown {
  return own(recordOf(settings), 'destination');
}

// A site is masked into every surface it can reach: 'current' with a DM fallback reaches both.
function routed(config: unknown, dm: boolean): Record<string, unknown> {
  const root = recordOf(config);
  const announcement = own(root, 'announcement');
  const almostThere = own(root, 'almostThere');
  const achievements = own(root, 'achievements');

  const moduleDestination = destinationOf(announcement) ?? 'current';
  const fallback = own(recordOf(announcement), 'fallback');

  const reaches = (destination: unknown): boolean =>
    dm
      ? destination === 'dm' || (destination === 'current' && fallback === 'dm')
      : destination !== 'dm';

  return {
    announcement: reaches(moduleDestination) ? announcement : undefined,
    almostThere: (destinationOf(almostThere) === 'dm') === dm ? almostThere : undefined,
    achievements: Array.isArray(achievements)
      ? achievements.map((achievement: unknown) =>
          reaches(destinationOf(own(recordOf(achievement), 'announcement')) ?? moduleDestination)
            ? achievement
            : undefined,
        )
      : undefined,
  };
}

export const achievementsTemplates: ModuleTemplates = Object.freeze({
  surfaces: Object.freeze(
    Object.fromEntries(Object.values(ACHIEVEMENT_SURFACES).map((surface) => [surface.id, surface])),
  ),
  collect: (config: unknown) => {
    const channel = routed(config, false);
    const dm = routed(config, true);

    return [
      ...collectConfigTemplates(channel, ACHIEVEMENT_UNLOCKED_SURFACE),
      ...collectConfigTemplates(dm, ACHIEVEMENT_UNLOCKED_DM_SURFACE),
      ...collectConfigTemplates(channel, ACHIEVEMENT_ALMOST_THERE_SURFACE),
      ...collectConfigTemplates(dm, ACHIEVEMENT_ALMOST_THERE_DM_SURFACE),
    ];
  },
});

export interface MessageRoute {
  kind: AchievementMessageKind;
  destination: AnnounceTarget;
  channelId: string | null;
  message: AnnouncementMessage;
  basePath: string;
}

export function unlockRoute(
  config: AchievementsConfig,
  achievement: Achievement | null,
): MessageRoute | null {
  const module = config.announcement;
  let destination: AnnounceTarget = module.destination;
  let channelId = module.channelId ?? null;
  let message = module.message;
  let basePath = ANNOUNCEMENT_BASE_PATH;

  if (achievement !== null) {
    const custom = achievement.announcement;
    if (custom.mode === 'off') return null;

    if (custom.mode === 'custom') {
      if (custom.destination !== undefined) {
        destination = custom.destination;
        channelId = custom.channelId ?? null;
      }

      const index = config.achievements.findIndex(({ id }) => id === achievement.id);
      if (custom.message !== undefined && index >= 0) {
        message = custom.message;
        basePath = `achievements.${index}.announcement.message`;
      }
    }
  }

  return {
    kind: destination === 'dm' ? 'unlocked_dm' : 'unlocked',
    destination,
    channelId,
    message,
    basePath,
  };
}

export function almostThereRoute(config: AchievementsConfig): MessageRoute {
  const { destination, channelId, message } = config.almostThere;

  return {
    kind: destination === 'dm' ? 'almost_there_dm' : 'almost_there',
    destination,
    channelId: channelId ?? null,
    message,
    basePath: ALMOST_THERE_BASE_PATH,
  };
}

export function messageTexts(message: AnnouncementMessage): string[] {
  return collectMessageSites(message, '').map(({ text }) => text);
}

export function usedAchievementKeys(
  kind: AchievementMessageKind,
  message: AnnouncementMessage,
): Set<string> {
  return usedKeys(ACHIEVEMENT_SURFACES[kind], messageTexts(message), { allowedOnly: true });
}

export function renderAchievementMessage(
  kind: AchievementMessageKind,
  message: AnnouncementMessage,
  facts: AchievementPlaceholderFacts,
  now: number,
  basePath: string,
): MessageRender<AnnouncementMessage> {
  const surface = ACHIEVEMENT_SURFACES[kind];

  return renderMessageTemplate(message, surface, surface.build(facts, { now }), {
    now,
    basePath,
    timeZone: facts.timeZone,
  });
}

export function withBadgeThumbnail(message: AnnouncementMessage): AnnouncementMessage {
  const [first, ...rest] = message.embeds;
  if (first === undefined || first.thumbnailUrl !== undefined) return message;

  // Not an embedLinkSchema link: this message is only ever sent, never parsed again.
  return {
    ...message,
    embeds: [{ ...first, thumbnailUrl: `attachment://${BADGE_FILENAME}` }, ...rest],
  };
}

// Only link buttons survive announcementMessageSchema, and a link button never asks for a custom_id.
const NO_CUSTOM_IDS: CustomIdFor = () => {
  throw new Error(
    'an achievements message carried a button or dropdown that is not a link, and Achievements ' +
      'does not answer presses on its announcements. Remove the component rows from the ' +
      'Achievements announcement settings.',
  );
};

export function toSendBody(
  kind: AchievementMessageKind,
  message: AnnouncementMessage,
  now: number,
): DiscordMessageBody {
  const body = toDiscordMessage(message, { customIdFor: NO_CUSTOM_IDS, now: new Date(now) });
  return isDirectMessageKind(kind) ? { ...body, allowedMentions: { parse: [] } } : body;
}
