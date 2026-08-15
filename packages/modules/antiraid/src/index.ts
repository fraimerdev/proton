import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { ANTIRAID_SCHEMA_VERSION, antiraidConfigSchema, antiraidDefaultConfig } from './config.ts';
import { type AntiraidDeps, createJoinListener } from './listener.ts';

export {
  ANTIRAID_SCHEMA_VERSION,
  type AntiraidConfig,
  antiraidConfigSchema,
  antiraidDefaultConfig,
  RAID_RESPONSES,
  type RaidResponse,
  readScoreSettings,
  type ScoreSettingsResult,
} from './config.ts';
export { type JoinFacts, readJoin } from './join.ts';
export {
  ANTIRAID_ACTOR,
  ANTIRAID_EVENT_TYPES,
  ANTIRAID_MODULE_ID,
  type AntiraidDeps,
  createJoinListener,
  JOIN_RATE_RULE_ID,
} from './listener.ts';
export {
  MAX_REASON_LENGTH,
  planResponse,
  RESPONSE_LABELS,
  type ResponsePlan,
  type ResponsePlanResult,
  responseKind,
  responseUnconfigured,
} from './response.ts';
export {
  type JoinSignals,
  MAX_JOIN_SCORE,
  MAX_SINGLE_SIGNAL_WEIGHT,
  MIN_ACTIONABLE_SCORE,
  type RaidScore,
  type ScoreSettings,
  SIGNAL_WEIGHTS,
  scoreJoin,
} from './score.ts';

/**
 * Anti-raid (PLAN.md §8, Phase 2).
 *
 * A factory rather than a constant because the join-rate window has to be
 * injected: §7's `ModuleContext` carries a config, an executor and a logger, and
 * nothing else, so a module cannot be handed the Redis primitive it counts with.
 * `createLoggingModule` works around the same gap for its store. When the
 * framework grows a port for shared primitives, this becomes a plain constant.
 *
 * What it does not do, and why:
 *
 *  - **It is not expressed as preset rules.** The rule engine already has
 *    `account-age` and a guild-scoped `rate-over-window`, and a rule combining
 *    them would be two thirds of this module. It stops at two thirds: there is no
 *    avatarless predicate, conditions are ANDed with no notion of a score, and
 *    §4-P2's predicate set is deliberately closed. Scoring in a listener keeps
 *    the closed vocabulary closed and keeps the weights in one readable file.
 *  - **It never Requests Guild Members.** Every signal comes from the dispatch
 *    or from the snowflake in the user id. §10.4 caps that call at one per guild
 *    per 30 seconds, so anything depending on it would be blind for the first
 *    minute of a raid.
 *  - **It cannot act retroactively on the joins before the crossing.** The
 *    accounts that arrived while the window was still filling were each screened
 *    on their own merits and let through if they scored low. Sweeping them up
 *    afterwards would need a per-guild list of recent joiners, which the rate
 *    window (a set of event ids) is not; a real sweep belongs with the anti-nuke
 *    breaker's restore story rather than being invented here.
 */
export function createAntiraidModule(
  deps: AntiraidDeps = {},
): ModuleManifest<typeof antiraidConfigSchema> {
  return {
    id: 'antiraid',
    name: 'Anti-raid',
    category: 'security',
    configSchema: antiraidConfigSchema,
    defaultConfig: antiraidDefaultConfig,
    schemaVersion: ANTIRAID_SCHEMA_VERSION,

    /**
     * GUILD_MEMBERS is privileged and the module is nothing without it: without
     * it GUILD_MEMBER_ADD is never dispatched at all, so the join counter would
     * read zero through a raid of a thousand accounts. Declaring it means the
     * registry disables the module with the intent named and the portal toggle to
     * flip (§7), instead of a guild discovering the silence during an attack.
     */
    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    /**
     * Both permissions the response ladder can need, as a hard gate.
     *
     * Unlike `cases`, which keeps ban rights out of its hard requirements so a
     * guild does not lose its moderation history for never granting them, this is
     * a security control whose entire value is being ready before the raid. A
     * guild that discovers at 3am that the bot cannot kick has learned it at the
     * one moment the answer is useless, so the registry says so up front and the
     * invite URL (§10.3) carries both.
     *
     * VIEW_CHANNEL and SEND_MESSAGES are deliberately absent: the alert channel is
     * optional, and gating raid protection on the bot's ability to talk would
     * disable it in servers that keep Proton silent. A missing send permission is
     * named by the executor's precheck instead (I8).
     */
    requiredPermissions: [Permissions.ManageRoles, Permissions.KickMembers],

    listeners: [createJoinListener(deps)],

    migrations: [],

    dashboard: {
      icon: 'shield-alert',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'alertChannelId'] },
        {
          id: 'detection',
          title: 'Detection',
          fields: [
            'joinWindow',
            'joinThreshold',
            'newAccountAge',
            'brandNewAccountAge',
            'scoreThreshold',
          ],
        },
        {
          id: 'response',
          title: 'Response',
          fields: ['response', 'verificationRoleId', 'quarantineRoleId'],
        },
      ],
    },
  };
}

/**
 * The module as the registry and dashboard see it, with no window bound.
 *
 * Safe because `enabled` defaults to false: a guild that has not configured
 * anti-raid gets no screening and no error. One that has enabled it gets an error
 * naming exactly what is unwired rather than silence (§1, §7).
 */
export const antiraidModule: ModuleManifest<typeof antiraidConfigSchema> = createAntiraidModule();

export default antiraidModule;
