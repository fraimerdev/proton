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

/**
 * Leveling — XP, ranks, leaderboards and role rewards (PLAN.md §8, Phase 3).
 *
 * A factory rather than a constant because both halves need storage and §7's
 * `ModuleContext` has no storage port — the same gap `logging`, `phishing`,
 * `backup` and `verification` each work around. Built with nothing bound it is
 * still a complete, valid, renderable manifest, which is what `apps/api` and the
 * dashboard construct; it reports its own unwiring by name (`describeUnbound`)
 * rather than going quiet.
 *
 * Two design decisions are recorded elsewhere and worth pointing at from here:
 *
 *  - **Role rewards are module logic, not preset rules**, unlike `autorole`'s
 *    grants. They key on "reached level N" and §4-P2's predicate set is
 *    deliberately closed with no numeric comparison in it; widening it to fit is
 *    what `antiraid` records declining to do. `xp.level_gained` is still
 *    published, so the rule builder can react to a level-up later — only the
 *    reward *mapping* is local. See `rewards.ts`.
 *  - **XP is awarded in one SQL statement**, cooldown included, because two
 *    messages arriving concurrently must award once and a read-modify-write does
 *    not achieve that. See `MemberXpStore.award` and its Drizzle implementation.
 */
export function createLevelingModule(
  deps: LevelingDeps = {},
): ModuleManifest<typeof levelingConfigSchema> {
  return {
    id: 'leveling',
    name: 'Leveling',
    category: 'engagement',
    configSchema: levelingConfigSchema,
    /**
     * `roleRewards` is an array of objects, which the v1 form generator refuses
     * by design (§9). It stays in `configSchema` — per-guild data validated on
     * every read and write (I5) and diffed for the audit trail (I7) — and the
     * dashboard gives it a bespoke editor, exactly as `cases` does with its
     * escalation ladder.
     */
    formSchema: levelingFormSchema,
    defaultConfig: levelingDefaultConfig,
    schemaVersion: LEVELING_SCHEMA_VERSION,

    /**
     * Message XP needs GuildMessages to see that a message happened. It does
     * **not** need MessageContent: XP is awarded per message, not per word, so
     * the content is never read — and asking for a privileged intent the module
     * does not use would be exactly what Discord's "You Might Not Need a
     * Privileged Intent" guidance warns against (§10.2).
     *
     * GuildVoiceStates carries VOICE_STATE_UPDATE, without which voice XP counts
     * zero seconds for every member forever. It is not privileged.
     *
     * GuildMembers is absent for the same reason MessageContent is: nothing here
     * watches members joining or their roles changing. Role rewards act on the
     * member the level-up is about, whose id the event already carries.
     */
    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],

    /**
     * Only what the module always needs: seeing a channel and posting a level-up
     * message in it.
     *
     * ManageRoles is deliberately **not** a hard gate, on `cases`' reasoning
     * rather than `antiraid`'s. Role rewards are optional — most guilds run
     * leveling for the leaderboard alone — and gating the whole module on a
     * permission only one feature needs would take XP away from every server
     * that never configured a reward. A reward the bot cannot grant fails at the
     * executor's precheck instead, which names the missing permission and the
     * role (I8), and that is the right layer for a per-feature requirement.
     */
    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],

    commands: levelingCommands(deps),
    listeners: [createMessageXpListener(deps), createVoiceXpListener(deps)],

    /**
     * The level-up event §4-P1 names, published through the allowlist so this
     * module never holds the bus (I3).
     *
     * Nothing consumes it yet — role rewards are applied locally, above. It is
     * published anyway because it is the seam: a guild's own rule reacting to a
     * level-up is the first thing the rule builder will be asked for, and an
     * event that only starts being emitted later is one no existing rule can be
     * written against.
     */
    emits: ['xp.level_gained'],

    /**
     * The leaderboard index ships in the core drizzle set as
     * `0004_leveling.sql`, not here: nothing runs `manifest.migrations`, which
     * `logging` documents and works around the same way. Listing it in both
     * places would be two copies of one DDL with no mechanism keeping them equal.
     */
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
        // `roleRewards` is listed so the section owns it, but no generated
        // descriptor will ever appear for it (§9) — a bespoke editor renders it.
        { id: 'rewards', title: 'Role rewards', fields: ['rewardMode', 'roleRewards'] },
      ],
    },
  };
}

/** The module as the registry and dashboard see it, with no storage bound. */
export const levelingModule: ModuleManifest<typeof levelingConfigSchema> = createLevelingModule();

export default levelingModule;
