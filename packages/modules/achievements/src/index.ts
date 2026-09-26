import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { achievementsCommands } from './commands.ts';
import {
  ACHIEVEMENTS_SCHEMA_VERSION,
  achievementsConfigSchema,
  achievementsDefaultConfig,
  achievementsFormSchema,
  MODULE_ID,
} from './config.ts';
import type { AchievementsDeps } from './deps.ts';
import { createAchievementsInteractionListener } from './interactions.ts';
import { ACHIEVEMENT_SCHEDULES, createScheduledHandlers } from './jobs.ts';
import { createAchievementsListeners } from './listeners.ts';
import { achievementsTemplates } from './placeholders.ts';
import { achievementsSimulations } from './simulation.ts';
import { validateConfig } from './validate.ts';

export {
  ANNOUNCE_LEASE_MS,
  announceDueGroup,
  announceIfReady,
  announceUnlockOf,
  BADGE_RENDER_BUDGET_MS,
  DM_CLOSED,
  sendAlmostThere,
} from './announce.ts';
export { badgeCardFor, renderBadgePng } from './badge.ts';
export {
  achievementsCommands,
  type LiveState,
  liveState,
  valuesOf,
} from './commands.ts';
export {
  ACHIEVEMENT_ID,
  ACHIEVEMENTS_CEILING,
  ACHIEVEMENTS_SCHEMA_VERSION,
  type Achievement,
  type AchievementInput,
  type AchievementsConfig,
  type AchievementsConfigInput,
  achievementSchema,
  achievementsConfigSchema,
  achievementsDefaultConfig,
  achievementsFormSchema,
  MODULE_ID,
  type Requirement,
  type Reward,
  type Tier,
} from './config.ts';
export * from './constants.ts';
export {
  type AchievementLimits,
  type AchievementsDeps,
  type ChannelKind,
  describeUnbound,
  type FencedLocks,
  type LevelHolder,
  type ListedMember,
  type MemberLookup,
  PORT_HINTS,
} from './deps.ts';
export {
  ACHIEVEMENT_JOB,
  activate,
  armDaily,
  armSweep,
  DAILY_JOB,
  DAY_MS,
  type EvaluateInput,
  evaluateMember,
  evaluateMemberUnlocks,
  handleConfigChanged,
  handleGuildAvailable,
  handleJobRequest,
  handleRetryRequest,
  handleXpGranted,
  maybeCheckState,
  type ProcessInput,
  processRecords,
  publishUnlocks,
  type RoutingIndex,
  routingOf,
  type StateCheckInput,
  type SubjectFacts,
  SWEEP_JOB,
  startsAfter,
  VOICE_JOB,
} from './engine.ts';
export { createAchievementsInteractionListener } from './interactions.ts';
export {
  ACHIEVEMENT_SCHEDULES,
  type AchievementSchedule,
  createScheduledHandlers,
  purgeAchievements,
} from './jobs.ts';
export { createAchievementsListeners } from './listeners.ts';
export { achievementsTemplates } from './placeholders.ts';
export { DrizzleAchievementStore } from './postgres-store.ts';
export { RedisFencedLocks, RedisLimits } from './redis-helpers.ts';
export {
  deliverDue,
  deliverRewards,
  isSettled,
  isTransientFailure,
  levelingOffReason,
  RANKED_TARGET,
  retryReward,
} from './rewards.ts';
export { achievementsSimulations } from './simulation.ts';
export type {
  AchievementStore,
  GuildRuntime,
  MemberAchievementState,
  RewardRow,
  UnlockRow,
} from './store.ts';
export { validateConfig } from './validate.ts';
export {
  type AchievementVoiceStore,
  RedisAchievementVoiceStore,
} from './voice-store.ts';

export function createAchievementsModule(
  deps: AchievementsDeps = {},
): ModuleManifest<typeof achievementsConfigSchema> {
  return {
    id: MODULE_ID,
    name: 'Achievements',
    category: 'engagement',
    configSchema: achievementsConfigSchema,

    formSchema: achievementsFormSchema,
    defaultConfig: achievementsDefaultConfig,
    schemaVersion: ACHIEVEMENTS_SCHEMA_VERSION,

    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
    ],

    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
    actionKinds: [
      'send',
      'create_dm',
      'add_role',
      'remove_role',
      'interaction_reply',
      'interaction_followup',
    ],

    emits: ['achievements.unlocked', 'xp.grant_requested'],

    schedules: [...ACHIEVEMENT_SCHEDULES],
    scheduledHandlers: createScheduledHandlers(deps),
    jobs: [{ id: 'purge', cron: '35 3 * * *' }],

    templates: achievementsTemplates,
    simulations: achievementsSimulations,

    commands: achievementsCommands(deps),
    listeners: [...createAchievementsListeners(deps), createAchievementsInteractionListener(deps)],
    interactionConcurrency: 4,

    configLimits: [{ key: 'achievements', path: 'achievements' }],
    refineWrite: validateConfig,

    dashboard: {
      icon: 'trophy',
      sections: [
        {
          id: 'general',
          title: 'General',
          fields: [
            'enabled',
            'timezone',
            'messageCooldown',
            'excludedChannelIds',
            'excludedRoleIds',
          ],
        },
      ],
    },
  };
}

export const achievementsModule: ModuleManifest<typeof achievementsConfigSchema> =
  createAchievementsModule();

export default achievementsModule;
