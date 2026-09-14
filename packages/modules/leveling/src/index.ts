import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { levelingCommands } from './commands.ts';
import {
  LEVELING_SCHEMA_VERSION,
  levelingConfigSchema,
  levelingDefaultConfig,
  levelingFormSchema,
} from './config.ts';
import type { LevelingDeps } from './deps.ts';
import { createMessageXpListener } from './message-xp.ts';
import { levelingTemplates } from './placeholders.ts';
import { createLevelingProviders } from './providers.ts';
import { createPruneHandler, createPruneListener, PRUNE_JOB_ID } from './prune.ts';
import { createVoiceXpListener } from './voice-xp.ts';

export {
  ACTIVITY_RETENTION_DAYS,
  ACTIVITY_WINDOW_DAYS,
  ACTIVITY_WINDOWS,
  type ActivityQuery,
  type ActivityStore,
  type ActivityTotals,
  type ActivityWindow,
  type MemberStats,
  utcDay,
  windowStart,
} from './activity.ts';
export {
  LEADERBOARD_MAX_PAGE,
  LEADERBOARD_PAGE_SIZE,
  leaderboardCommand,
  levelingCommands,
  rankCommand,
  xpCommand,
} from './commands.ts';
export { LEVEL_UP_ACTION, levelUpCustomId } from './component-id.ts';
export {
  type ChannelMultiplier,
  channelMultiplierSchema,
  channelMultipliersSchema,
  DEFAULT_LEVEL_UP,
  DEFAULT_LEVEL_UP_MESSAGE,
  isSilentLevelUp,
  LEVEL_UP_PLACEHOLDERS,
  LEVELING_SCHEMA_VERSION,
  type LevelingConfig,
  type LevelingSettings,
  type LevelUpMessage,
  levelingConfigSchema,
  levelingDefaultConfig,
  levelingFormSchema,
  levelUpMessageSchema,
  liftLevelUpMessage,
  MULTIPLIER_CHANNEL_TYPES,
  REWARD_MODES,
  type RewardMode,
  type RoleMultiplier,
  type RoleReward,
  readSettings,
  roleMultiplierSchema,
  roleMultipliersSchema,
  roleRewardSchema,
  roleRewardsSchema,
  rollMessageXp,
  type SettingsResult,
  XP_EVENT_MAX_DURATION_MS,
  XP_EVENT_MAX_LEAD_MS,
  XP_EVENT_MAX_PENDING,
  XP_EVENT_MIN_DURATION_MS,
  XP_EVENT_MULTIPLIER_MAX,
  XP_EVENT_MULTIPLIER_MIN,
  XP_EVENT_RETENTION_MS,
  XP_EVENT_START_GRACE_MS,
  XP_EVENT_STATUSES,
  XP_MULTIPLIER_LIST_MAX,
  XP_MULTIPLIER_MAX,
  XP_MULTIPLIER_MIN,
  XP_MULTIPLIER_STEP,
  type XpEventBoundsIssue,
  type XpEventCreate,
  type XpEventStatus,
  type XpEventView,
  xpEventBoundsIssue,
  xpEventCreateSchema,
  xpEventCreateSchemaAt,
  xpEventMultiplierSchema,
  xpEventViewSchema,
  xpMultiplierSchema,
} from './config.ts';
export {
  type LevelProgress,
  levelForXp,
  levelProgress,
  MAX_LEVEL,
  MAX_XP,
  STEP_BASE,
  STEP_GROWTH,
  xpForLevel,
  xpForStep,
} from './curve.ts';
export {
  bindVoice,
  bindXp,
  bindXpEvents,
  clockOf,
  describeUnbound,
  type LevelingDeps,
  type XpEventBinding,
} from './deps.ts';
export { XP_EVENT_GROUP, xpEventId } from './event-commands.ts';
export {
  applyLevelUp,
  type LevelingRenderDeps,
  type LevelUp,
  type LevelUpBody,
  type LevelUpRender,
  type LevelUpSource,
  renderLevelUpMessage,
} from './level-up.ts';
export {
  type AuthorFacts,
  createMessageXpListener,
  MESSAGE_XP_EVENT_TYPES,
  readAuthorFacts,
  readMessage,
  type XpMessage,
} from './message-xp.ts';
export {
  activeXpEvents,
  channelChain,
  type MessageCandidateInput,
  type MultiplierRules,
  messageXpCandidates,
  resolveXpMultiplier,
  type StaticCandidateInput,
  scaleMessageXp,
  staticXpCandidates,
  type VoicePayoutInput,
  voiceXpPayout,
  type XpEventWindow,
} from './multipliers.ts';
export {
  LEVEL_UP_BASE_PATH,
  LEVEL_UP_RANK_KEYS,
  LEVEL_UP_RANKED_COUNT_KEY,
  LEVEL_UP_SURFACE,
  type LevelUpPlaceholderFacts,
  type LevelUpRank,
  type LevelUpRewards,
  levelingTemplates,
} from './placeholders.ts';
export { createLevelingProviders, LEVELING_MODULE_ID } from './providers.ts';
export {
  armPrune,
  createPruneHandler,
  createPruneListener,
  PRUNE_EVENT_TYPES,
  PRUNE_INTERVAL_MS,
  PRUNE_JOB_ID,
  PRUNE_KEY,
} from './prune.ts';
export { RedisVoiceSessionStore } from './redis-session-store.ts';
export {
  planRoleRewards,
  type RewardPlan,
  type RewardPlanInput,
  rewardRoleIds,
} from './rewards.ts';
export type {
  AdjustInput,
  AwardInput,
  AwardResult,
  Instant,
  MemberXpStore,
  VoiceCreditInput,
  XP_ADJUSTMENTS,
  XpAdjustment,
} from './store.ts';
export type { VoiceSession, VoiceSessionStore } from './voice-session.ts';
export {
  createVoiceXpListener,
  readVoiceState,
  VOICE_XP_EVENT_TYPES,
  type VoiceState,
} from './voice-xp.ts';
export {
  CachedXpEventStore,
  type CachedXpEventStoreOptions,
  XP_EVENT_CACHE_TTL_MS,
} from './xp-event-cache.ts';
export {
  type CreateXpEventInput,
  type CreateXpEventResult,
  createXpEvent,
  type EndXpEventAudit,
  type EndXpEventResult,
  toXpEventView,
  type XpEvent,
  type XpEventStore,
  xpEventStatus,
} from './xp-events.ts';

export function createLevelingModule(
  deps: LevelingDeps = {},
): ModuleManifest<typeof levelingConfigSchema> {
  return {
    id: 'leveling',
    name: 'Leveling',
    category: 'engagement',
    configSchema: levelingConfigSchema,

    formSchema: levelingFormSchema,
    defaultConfig: levelingDefaultConfig,
    schemaVersion: LEVELING_SCHEMA_VERSION,

    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],

    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
    actionKinds: ['add_role', 'remove_role', 'send', 'interaction_reply', 'interaction_followup'],

    commands: levelingCommands(deps),
    listeners: [
      createMessageXpListener(deps),
      createVoiceXpListener(deps),
      ...(deps.activity ? [createPruneListener(deps)] : []),
    ],

    ...(deps.activity ? { providers: createLevelingProviders(deps.activity) } : {}),

    // Windowed conditions only ever look back 30 days, so anything older is dead weight that
    // grows without bound. Registered only when there is a store to prune.
    ...(deps.activity
      ? {
          schedules: [PRUNE_JOB_ID],
          scheduledHandlers: {
            [PRUNE_JOB_ID]: createPruneHandler(deps.activity, deps.now, deps.xpEvents),
          },
        }
      : {}),

    emits: ['xp.level_gained'],

    templates: levelingTemplates,

    dashboard: {
      icon: 'trending-up',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        {
          id: 'card',
          title: 'Rank card',
          fields: [
            'rankCard',
            'cardPreset',
            'cardAccent',
            'cardBackgroundUrl',
            'cardShowRank',
            'cardShowPercent',
            'cardShowTotalXp',
          ],
        },
        {
          id: 'message',
          title: 'Message XP',
          fields: ['xpPerMessageMin', 'xpPerMessageMax', 'messageCooldown'],
        },
        { id: 'voice', title: 'Voice XP', fields: ['voiceXpPerMinute', 'afkChannelId'] },
        {
          id: 'multipliers',
          title: 'XP multipliers',
          fields: ['roleMultipliers', 'channelMultipliers'],
        },
        { id: 'announce', title: 'Level-up announcement', fields: ['levelUpChannelId'] },
        {
          id: 'exclusions',
          title: 'Exclusions',
          fields: ['excludedChannelIds', 'excludedRoleIds'],
        },

        { id: 'rewards', title: 'Role rewards', fields: ['rewardMode', 'roleRewards'] },
      ],
    },
  };
}

export const levelingModule: ModuleManifest<typeof levelingConfigSchema> = createLevelingModule();

export default levelingModule;
