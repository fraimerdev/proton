import { limitFor } from '@proton/core';
import {
  REACTION_MAX_AGE_MS,
  REACTIONS_GIVEN_DAILY_CAP,
  REACTIONS_PAIR_DAILY_CAP,
} from './constants.ts';

export const LEDGER_METRICS = [
  'messages',
  'active_days',
  'voice_minutes',
  'voice_stay',
  'reactions_given',
  'reactions_received',
  'starboard_messages',
  'boosts',
  'giveaways_entered',
  'giveaways_won',
  'activity_xp',
  'applications_accepted',
] as const;

export type LedgerMetric = (typeof LEDGER_METRICS)[number];

export const STATE_METRICS = [
  'level',
  'membership_days',
  'achievement_tier',
  'achievements_earned',
] as const;

export type StateMetric = (typeof STATE_METRICS)[number];

export type Metric = LedgerMetric | StateMetric;

export const MEASUREMENTS = ['count', 'duration', 'state', 'record'] as const;

export type Measurement = (typeof MEASUREMENTS)[number];

export const TRIGGER_GROUPS = [
  'Messages',
  'Voice',
  'Reactions',
  'Starboard',
  'Boosting',
  'Membership',
  'Leveling',
  'Giveaways',
  'Applications',
  'Achievements',
] as const;

export type TriggerGroup = (typeof TRIGGER_GROUPS)[number];

export const DEPENDENCY_MODULES = [
  'leveling',
  'starboard',
  'tempvc',
  'giveaways',
  'applications',
] as const;

export type DependencyModule = (typeof DEPENDENCY_MODULES)[number];

export type TriggerSource = 'discord' | DependencyModule | 'achievements';

export const TRIGGER_IDS = [
  'messages.sent',
  'activity.active_days',
  'voice.minutes',
  'voice.longest_stay',
  'tempvc.minutes',
  'reactions.given',
  'reactions.received',
  'starboard.messages',
  'boosts.started',
  'membership.days',
  'leveling.level',
  'leveling.activity_xp',
  'giveaways.entered',
  'giveaways.won',
  'applications.accepted',
  'achievements.earned',
  'achievements.unlocked',
] as const;

export type TriggerId = (typeof TRIGGER_IDS)[number];

export interface TriggerDefinition {
  id: TriggerId;
  label: string;
  group: TriggerGroup;
  summary: string;
  rule: string;
  sourceModule: TriggerSource;
  dependsOn: DependencyModule | null;
  measurement: Measurement;
  metric: Metric;
  temporaryOnly?: true;
  unit: { one: string; many: string };
  target: { min: number; max: number };
  filters: { channels: boolean; xpSources: boolean; achievement: boolean };
  tiered: boolean;
  history: 'recorded' | 'state';
  stateNote?: string;
  originChannel: boolean;
}

const REACTION_MAX_AGE_DAYS = REACTION_MAX_AGE_MS / (24 * 60 * 60 * 1000);

// Leveling's MAX_LEVEL: a module never imports another module.
const LEVEL_MAX = 1000;

const CHANNELS = { channels: true, xpSources: false, achievement: false };
const NO_FILTERS = { channels: false, xpSources: false, achievement: false };

const DEFINITIONS: { [K in TriggerId]: TriggerDefinition & { id: K } } = {
  'messages.sent': {
    id: 'messages.sent',
    label: 'Send messages',
    group: 'Messages',
    summary: 'Messages sent in text channels and threads.',
    rule:
      'Messages and replies in text channels and threads. Messages from bots and webhooks, ' +
      'system messages and ticket channels never count. A member’s messages count at most once ' +
      'per message cooldown.',
    sourceModule: 'discord',
    dependsOn: null,
    measurement: 'count',
    metric: 'messages',
    unit: { one: 'message', many: 'messages' },
    target: { min: 1, max: 1_000_000 },
    filters: CHANNELS,
    tiered: true,
    history: 'recorded',
    originChannel: true,
  },

  'activity.active_days': {
    id: 'activity.active_days',
    label: 'Be active on different days',
    group: 'Messages',
    summary: 'Days with a message or time in voice.',
    rule:
      'Each calendar day, in the module’s time zone, on which the member sent a message or spent ' +
      'a minute in voice that counts. Each day counts once.',
    sourceModule: 'discord',
    dependsOn: null,
    measurement: 'count',
    metric: 'active_days',
    unit: { one: 'active day', many: 'active days' },
    target: { min: 1, max: 3650 },
    filters: NO_FILTERS,
    tiered: true,
    history: 'recorded',
    originChannel: true,
  },

  'voice.minutes': {
    id: 'voice.minutes',
    label: 'Spend time in voice',
    group: 'Voice',
    summary: 'Minutes spent in voice and stage channels.',
    rule:
      'Whole minutes in voice and stage channels while not deafened. Muted or alone still ' +
      'counts, but the AFK channel and bots never do. One stay counts for at most 24 hours.',
    sourceModule: 'discord',
    dependsOn: null,
    measurement: 'duration',
    metric: 'voice_minutes',
    unit: { one: 'voice minute', many: 'voice minutes' },
    target: { min: 1, max: 1_000_000 },
    filters: CHANNELS,
    tiered: true,
    history: 'recorded',
    originChannel: false,
  },

  'voice.longest_stay': {
    id: 'voice.longest_stay',
    label: 'Stay in voice in one go',
    group: 'Voice',
    summary: 'The longest single stay in a voice channel.',
    rule:
      'The longest single stay in one voice channel while not deafened, up to 24 hours. Moving ' +
      'to another channel starts a new stay.',
    sourceModule: 'discord',
    dependsOn: null,
    measurement: 'record',
    metric: 'voice_stay',
    unit: { one: 'minute in one stay', many: 'minutes in one stay' },
    target: { min: 1, max: 24 * 60 },
    filters: CHANNELS,
    tiered: true,
    history: 'recorded',
    originChannel: false,
  },

  'tempvc.minutes': {
    id: 'tempvc.minutes',
    label: 'Spend time in temporary voice channels',
    group: 'Voice',
    summary: 'Minutes spent in channels Temporary Voice Channels created.',
    rule:
      'Voice minutes, but only in channels Temporary Voice Channels created. The channel members ' +
      'join to create one doesn’t count.',
    sourceModule: 'tempvc',
    dependsOn: 'tempvc',
    measurement: 'duration',
    metric: 'voice_minutes',
    temporaryOnly: true,
    unit: { one: 'temporary voice minute', many: 'temporary voice minutes' },
    target: { min: 1, max: 1_000_000 },
    filters: CHANNELS,
    tiered: true,
    history: 'recorded',
    originChannel: false,
  },

  'reactions.given': {
    id: 'reactions.given',
    label: 'React to messages',
    group: 'Reactions',
    summary: 'Reactions added to other members’ messages.',
    rule:
      `One per message, only on messages under ${REACTION_MAX_AGE_DAYS} days old, and at most ` +
      `${REACTIONS_GIVEN_DAILY_CAP} a day. Reactions from bots, on the member’s own messages or ` +
      'on Proton’s messages don’t count.',
    sourceModule: 'discord',
    dependsOn: null,
    measurement: 'count',
    metric: 'reactions_given',
    unit: { one: 'reaction given', many: 'reactions given' },
    target: { min: 1, max: 1_000_000 },
    filters: CHANNELS,
    tiered: true,
    history: 'recorded',
    originChannel: true,
  },

  'reactions.received': {
    id: 'reactions.received',
    label: 'Receive reactions',
    group: 'Reactions',
    summary: 'Reactions other members add to the member’s messages.',
    rule:
      `One per member per message, at most ${REACTIONS_PAIR_DAILY_CAP} a day from the same ` +
      `member, and only on messages under ${REACTION_MAX_AGE_DAYS} days old. Bots’ reactions and ` +
      'the member’s own reactions don’t count.',
    sourceModule: 'discord',
    dependsOn: null,
    measurement: 'count',
    metric: 'reactions_received',
    unit: { one: 'reaction received', many: 'reactions received' },
    target: { min: 1, max: 1_000_000 },
    filters: CHANNELS,
    tiered: true,
    history: 'recorded',
    originChannel: true,
  },

  'starboard.messages': {
    id: 'starboard.messages',
    label: 'Get messages onto the starboard',
    group: 'Starboard',
    summary: 'Distinct messages Starboard posts.',
    rule:
      'Each of the member’s messages Starboard posts counts once, even if it drops off and comes ' +
      'back. Messages from bots and webhooks never count.',
    sourceModule: 'starboard',
    dependsOn: 'starboard',
    measurement: 'count',
    metric: 'starboard_messages',
    unit: { one: 'starboard message', many: 'starboard messages' },
    target: { min: 1, max: 100_000 },
    filters: CHANNELS,
    tiered: true,
    history: 'recorded',
    originChannel: true,
  },

  'boosts.started': {
    id: 'boosts.started',
    label: 'Boost the server',
    group: 'Boosting',
    summary: 'Starting to boost the server.',
    rule:
      'Counts each time a member starts boosting while Achievements is on. Adding boosts while ' +
      'already boosting doesn’t count again, because Discord doesn’t say how many a member has.',
    sourceModule: 'discord',
    dependsOn: null,
    measurement: 'count',
    metric: 'boosts',
    unit: { one: 'boost', many: 'boosts' },
    target: { min: 1, max: 100 },
    filters: NO_FILTERS,
    tiered: true,
    history: 'recorded',
    originChannel: true,
  },

  'membership.days': {
    id: 'membership.days',
    label: 'Stay a member',
    group: 'Membership',
    summary: 'Days since joining the server.',
    rule: 'Days since the member last joined the server. Rejoining starts the count again.',
    sourceModule: 'discord',
    dependsOn: null,
    measurement: 'state',
    metric: 'membership_days',
    unit: { one: 'day as a member', many: 'days as a member' },
    target: { min: 1, max: 3650 },
    filters: NO_FILTERS,
    tiered: true,
    history: 'state',
    stateNote:
      'Members already past a milestone earn it within a few minutes of the achievement going ' +
      'active. Everyone else earns it on the day they pass it.',
    originChannel: false,
  },

  'leveling.level': {
    id: 'leveling.level',
    label: 'Reach a level',
    group: 'Leveling',
    summary: 'The member’s Leveling level.',
    rule: 'The member’s Leveling level. Losing levels never removes an earned tier.',
    sourceModule: 'leveling',
    dependsOn: 'leveling',
    measurement: 'state',
    metric: 'level',
    unit: { one: 'level', many: 'levels' },
    target: { min: 1, max: LEVEL_MAX },
    filters: NO_FILTERS,
    tiered: true,
    history: 'state',
    stateNote:
      'Members already at or above it earn it within a few minutes of the achievement going ' +
      'active.',
    originChannel: true,
  },

  'leveling.activity_xp': {
    id: 'leveling.activity_xp',
    label: 'Earn XP from activity',
    group: 'Leveling',
    summary: 'XP Leveling gives for messages and voice.',
    rule:
      'XP Leveling gives for messages and voice. Achievement rewards and staff adjustments ' +
      'don’t count unless you add them as sources.',
    sourceModule: 'leveling',
    dependsOn: 'leveling',
    measurement: 'count',
    metric: 'activity_xp',
    unit: { one: 'XP', many: 'XP' },
    target: { min: 1, max: 100_000_000 },
    filters: { channels: false, xpSources: true, achievement: false },
    tiered: true,
    history: 'recorded',
    originChannel: true,
  },

  'giveaways.entered': {
    id: 'giveaways.entered',
    label: 'Enter giveaways',
    group: 'Giveaways',
    summary: 'Distinct giveaways entered.',
    rule:
      'Each giveaway the member entered counts once, when it ends. Cancelled giveaways don’t ' +
      'count, and leaving or being disqualified doesn’t take an entry back.',
    sourceModule: 'giveaways',
    dependsOn: 'giveaways',
    measurement: 'count',
    metric: 'giveaways_entered',
    unit: { one: 'giveaway entered', many: 'giveaways entered' },
    target: { min: 1, max: 10_000 },
    filters: NO_FILTERS,
    tiered: true,
    history: 'recorded',
    originChannel: true,
  },

  'giveaways.won': {
    id: 'giveaways.won',
    label: 'Win giveaways',
    group: 'Giveaways',
    summary: 'Distinct giveaways won, drops included.',
    rule:
      'Each giveaway the member won counts once, including drops and rerolls that picked them. A ' +
      'reroll never takes a win back.',
    sourceModule: 'giveaways',
    dependsOn: 'giveaways',
    measurement: 'count',
    metric: 'giveaways_won',
    unit: { one: 'giveaway won', many: 'giveaways won' },
    target: { min: 1, max: 10_000 },
    filters: NO_FILTERS,
    tiered: true,
    history: 'recorded',
    originChannel: true,
  },

  'applications.accepted': {
    id: 'applications.accepted',
    label: 'Get applications accepted',
    group: 'Applications',
    summary: 'The member’s applications that staff accept.',
    rule:
      'Each of the member’s applications counts once, when staff accept it. Reopening and ' +
      'accepting it again doesn’t count twice, and reopening or rejecting it later doesn’t take ' +
      'it back.',
    sourceModule: 'applications',
    dependsOn: 'applications',
    measurement: 'count',
    metric: 'applications_accepted',
    unit: { one: 'application accepted', many: 'applications accepted' },
    target: { min: 1, max: 1000 },
    filters: NO_FILTERS,
    tiered: true,
    history: 'recorded',
    originChannel: false,
  },

  'achievements.earned': {
    id: 'achievements.earned',
    label: 'Earn other achievements',
    group: 'Achievements',
    summary: 'How many other achievements the member holds.',
    rule:
      'How many other achievements the member holds, at any tier. Achievements that count other ' +
      'achievements are left out.',
    sourceModule: 'achievements',
    dependsOn: null,
    measurement: 'state',
    metric: 'achievements_earned',
    unit: { one: 'achievement', many: 'achievements' },
    target: { min: 1, max: limitFor('pro', 'achievements') },
    filters: NO_FILTERS,
    tiered: true,
    history: 'state',
    stateNote:
      'Members who already hold enough achievements earn it within a few minutes of it going ' +
      'active.',
    originChannel: true,
  },

  'achievements.unlocked': {
    id: 'achievements.unlocked',
    label: 'Earn a specific achievement',
    group: 'Achievements',
    summary: 'Holding a chosen tier of another achievement.',
    rule:
      'The member holds at least the chosen tier of another achievement. Only single ' +
      'achievements can use this, and achievements can’t require each other in a loop.',
    sourceModule: 'achievements',
    dependsOn: null,
    measurement: 'state',
    metric: 'achievement_tier',
    unit: { one: 'achievement', many: 'achievements' },
    target: { min: 1, max: 1 },
    filters: { channels: false, xpSources: false, achievement: true },
    tiered: false,
    history: 'state',
    stateNote:
      'Members who already hold the chosen tier earn it within a few minutes of it going active.',
    originChannel: true,
  },
};

export const TRIGGERS: readonly TriggerDefinition[] = TRIGGER_IDS.map((id) => DEFINITIONS[id]);

export function triggerOf(id: TriggerId): TriggerDefinition {
  return DEFINITIONS[id];
}

export function isTriggerId(value: string): value is TriggerId {
  return Object.hasOwn(DEFINITIONS, value);
}

export function aggregateOf(trigger: TriggerDefinition): 'sum' | 'max' {
  return trigger.measurement === 'record' ? 'max' : 'sum';
}

export const DEFAULT_XP_SOURCES = ['message', 'voice'] as const;

export const REWARD_KIND_IDS = ['add_role', 'remove_role', 'xp'] as const;

export type RewardKind = (typeof REWARD_KIND_IDS)[number];

export interface RewardKindDefinition {
  kind: RewardKind;
  label: string;
  dependsOn?: DependencyModule;
}

export const REWARD_KINDS: readonly RewardKindDefinition[] = [
  { kind: 'add_role', label: 'Give a role' },
  { kind: 'remove_role', label: 'Remove a role' },
  { kind: 'xp', label: 'Give XP', dependsOn: 'leveling' },
];

export const DEPENDENCY_LABELS: Record<DependencyModule, string> = {
  leveling: 'Leveling',
  starboard: 'Starboard',
  tempvc: 'Temporary Voice Channels',
  giveaways: 'Giveaways',
  applications: 'Applications',
};
