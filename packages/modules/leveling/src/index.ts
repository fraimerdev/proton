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
import { createLevelingProviders } from './providers.ts';
import { createPruneHandler, PRUNE_JOB_ID } from './prune.ts';
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
  REWARD_MODES,
  type RewardMode,
  type RoleReward,
  readSettings,
  roleRewardSchema,
  roleRewardsSchema,
  rollMessageXp,
  type SettingsResult,
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
export { bindVoice, bindXp, clockOf, describeUnbound, type LevelingDeps } from './deps.ts';
export {
  applyLevelUp,
  type LevelUp,
  type LevelUpBody,
  type LevelUpRender,
  type LevelUpSource,
  type LevelUpValues,
  renderLevelUpMessage,
} from './level-up.ts';
export {
  createMessageXpListener,
  MESSAGE_XP_EVENT_TYPES,
  readMessage,
  type XpMessage,
} from './message-xp.ts';
export { createLevelingProviders, LEVELING_MODULE_ID } from './providers.ts';
export { createPruneHandler, PRUNE_JOB_ID } from './prune.ts';
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
    actionKinds: ['add_role', 'remove_role', 'send', 'interaction_reply'],

    commands: levelingCommands(deps),
    listeners: [createMessageXpListener(deps), createVoiceXpListener(deps)],

    ...(deps.activity ? { providers: createLevelingProviders(deps.activity) } : {}),

    // Windowed conditions only ever look back 30 days, so anything older is dead weight that
    // grows without bound. Registered only when there is a store to prune.
    ...(deps.activity
      ? {
          schedules: [PRUNE_JOB_ID],
          scheduledHandlers: { [PRUNE_JOB_ID]: createPruneHandler(deps.activity, deps.now) },
        }
      : {}),

    emits: ['xp.level_gained'],

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
