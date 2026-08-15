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
import { createVoiceXpListener } from './voice-xp.ts';

export {
  LEADERBOARD_MAX_PAGE,
  LEADERBOARD_PAGE_SIZE,
  leaderboardCommand,
  levelingCommands,
  rankCommand,
  xpCommand,
} from './commands.ts';
export {
  DEFAULT_LEVEL_UP_MESSAGE,
  LEVEL_UP_PLACEHOLDERS,
  LEVELING_SCHEMA_VERSION,
  type LevelingConfig,
  type LevelingSettings,
  levelingConfigSchema,
  levelingDefaultConfig,
  levelingFormSchema,
  REWARD_MODES,
  type RewardMode,
  type RoleReward,
  readSettings,
  renderLevelUpMessage,
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
export { applyLevelUp, type LevelUp, type LevelUpSource } from './level-up.ts';
export {
  createMessageXpListener,
  MESSAGE_XP_EVENT_TYPES,
  readMessage,
  type XpMessage,
} from './message-xp.ts';
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

    commands: levelingCommands(deps),
    listeners: [createMessageXpListener(deps), createVoiceXpListener(deps)],

    emits: ['xp.level_gained'],

    migrations: [],

    dashboard: {
      icon: 'trending-up',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        {
          id: 'message',
          title: 'Message XP',
          fields: ['xpPerMessageMin', 'xpPerMessageMax', 'messageCooldown'],
        },
        { id: 'voice', title: 'Voice XP', fields: ['voiceXpPerMinute', 'afkChannelId'] },
        {
          id: 'announce',
          title: 'Level-up announcement',
          fields: ['levelUpMessage', 'levelUpChannelId'],
        },
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
