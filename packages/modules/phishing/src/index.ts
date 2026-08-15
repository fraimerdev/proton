import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createPhishingStatusCommand } from './commands.ts';
import { PHISHING_SCHEMA_VERSION, phishingConfigSchema, phishingDefaultConfig } from './config.ts';
import type { PhishingDeps } from './deps.ts';
import { createPhishingListener } from './listener.ts';
import { BLOCKLIST_REFRESH_CRON, BLOCKLIST_REFRESH_JOB_ID } from './refresh.ts';

export { createPhishingStatusCommand } from './commands.ts';
export {
  PHISHING_ACTIONS,
  PHISHING_SCHEMA_VERSION,
  type PhishingAction,
  type PhishingConfig,
  phishingConfigSchema,
  phishingDefaultConfig,
} from './config.ts';
export {
  type BindResult,
  type BoundPhishingDeps,
  bindDeps,
  describeUnbound,
  type PhishingDeps,
} from './deps.ts';
export {
  type BlocklistLookup,
  type InspectedMessage,
  inspectMessage,
  type MatchSource,
  type PhishingVerdict,
  readMessage,
} from './detect.ts';
export {
  DOMAIN_MAX_LENGTH,
  domainCandidates,
  extractHosts,
  firstMatch,
  type HostCandidates,
  MAX_HOSTS_PER_MESSAGE,
  MAX_SUFFIXES_PER_HOST,
  messageCandidates,
  normaliseDomain,
  toDomainSet,
} from './domains.ts';
export {
  type BlocklistFeedOptions,
  type BlocklistFetch,
  DEFAULT_BLOCKLIST_FEEDS,
  FEED_MAX_BYTES,
  FEED_TIMEOUT_MS,
  FEED_USER_AGENT,
  type FeedFailure,
  type FeedResult,
  fetchBlocklist,
  parseFeedBody,
} from './feeds.ts';
export { createPhishingListener, MODULE_ID, PHISHING_EVENT_TYPES } from './listener.ts';
export {
  BLOCKLIST_PREFIX,
  BLOCKLIST_TTL_MS,
  RedisBlocklistStore,
  type RedisBlocklistStoreOptions,
} from './redis-store.ts';
export {
  BLOCKLIST_QUEUE,
  BLOCKLIST_REFRESH_CRON,
  BLOCKLIST_REFRESH_JOB_ID,
  type RefreshBlocklistDeps,
  type RefreshOutcome,
  refreshBlocklist,
} from './refresh.ts';
export type {
  BlocklistInstall,
  BlocklistStats,
  BlocklistStore,
} from './store.ts';

/**
 * Phishing-link detection via community blocklist feeds (PLAN.md §8, Phase 2).
 *
 * A factory rather than a constant for the same reason `createLoggingModule` is
 * one: the module needs a cache and its own user id, and §7's `ModuleContext`
 * supplies neither. See `PhishingDeps`.
 *
 * **This is the only Gate 2 feature with a live external dependency**, and every
 * design choice in the package follows from that. The feeds are fetched
 * concurrently and isolated from one another; a refresh that produces nothing is
 * refused rather than installed, so a total feed outage keeps the previous list
 * instead of silently disarming every server; the cached list carries a
 * staleness TTL so a dead refresher eventually becomes visible instead of
 * enforcing an ancient list forever; and no failure path in the listener throws,
 * because a throw would leave the event unacknowledged and turn a blocklist
 * problem into a message-processing outage for every other module on the bus.
 * The module degrades to "no blocklist", says why, and gets out of the way.
 *
 * Known blockers, all outside a module's remit:
 *
 *  1. **There is no way to delete the offending message.** `ACTION_KINDS` has
 *     `purge`, whose payload requires 2–100 message ids because it maps to
 *     Discord's bulk-delete endpoint; a single message needs
 *     `DELETE /channels/{id}/messages/{id}`, which is a different endpoint and a
 *     kind Proton does not have. Building the REST call here would violate I1
 *     and I2, so the module times out the author and posts an alert that says in
 *     as many words that the message is still up. Closing this needs a
 *     `delete_message` kind in `packages/core` — payload, `REQUIRED_PERMISSIONS`
 *     (MANAGE_MESSAGES), `TARGETS_MEMBER: false`, and a `rest-mapping` case.
 *     It is the single largest gap between this module and what a server expects
 *     a phishing filter to do.
 *  2. **A listener runs against the unscoped executor.** It has no
 *     `app_permissions`, and the alert channel is usually not the channel the
 *     message was posted in, so prechecks are computed at guild level. An
 *     overwrite denying SEND_MESSAGES in the alert channel therefore surfaces as
 *     Discord's 403 rather than as a named precheck failure.
 *
 * Both of the framework gaps this module used to name are now closed: the
 * scanner runs on `ModuleListenerRuntime`, and the hourly refresh below runs on
 * `apps/worker/src/module-jobs.ts`, which fails at boot if a declared job has no
 * handler. `refreshBlocklist` stays exported for that runner to call, because a
 * module owning a queue connection is infrastructure a manifest should not hold.
 */
export function createPhishingModule(
  deps: PhishingDeps = {},
): ModuleManifest<typeof phishingConfigSchema> {
  return {
    id: 'phishing',
    name: 'Phishing links',
    category: 'security',
    configSchema: phishingConfigSchema,
    defaultConfig: phishingDefaultConfig,
    schemaVersion: PHISHING_SCHEMA_VERSION,

    /**
     * MESSAGE_CONTENT is privileged and the module is meaningless without it:
     * Discord blanks `content` on MESSAGE_CREATE for apps that lack it, so every
     * message would scan as an empty string and the module would report itself
     * healthy while catching nothing. Declaring it means the registry disables
     * the module and names the intent and the portal toggle, rather than a guild
     * discovering it the first time a scam link goes through untouched (§7).
     *
     * Granted per CLAUDE.md's recorded decision (Server Members + Message
     * Content), so this is a declaration, not a request.
     */
    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],

    /**
     * VIEW_CHANNEL only.
     *
     * It is the permission that decides whether message events reach the bot at
     * all, so without it the module genuinely cannot function. Not
     * ModerateMembers, BanMembers or KickMembers, even though `action` can ask
     * for each: `requiredPermissions` is a hard gate that disables the module
     * outright, and gating detection on ban rights would leave a server that
     * never grants bans with no phishing protection *and* no alerts, rather than
     * with the alerts it asked for. A configured action the bot cannot perform
     * fails at the executor's precheck instead, which names the missing
     * permission and where (I8) — the right layer for a per-action requirement.
     * SEND_MESSAGES is excluded on the same grounds: the alert channel is
     * optional, and requiring it would disable the module in servers that never
     * intended the bot to talk.
     */
    requiredPermissions: [Permissions.ViewChannel],

    commands: [createPhishingStatusCommand(deps)],
    listeners: [createPhishingListener(deps)],

    jobs: [
      {
        id: BLOCKLIST_REFRESH_JOB_ID,
        cron: BLOCKLIST_REFRESH_CRON,
        // No timezone: the feeds are global static files and the schedule is a
        // polling interval, not a wall-clock appointment. A local-time schedule
        // would skip or double an hour twice a year for no benefit.
      },
    ],

    migrations: [],

    dashboard: {
      icon: 'fish',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'alertChannel'] },
        { id: 'response', title: 'Response', fields: ['action', 'timeoutDuration'] },
        { id: 'lists', title: 'Domain lists', fields: ['blockDomains', 'allowDomains'] },
      ],
    },
  };
}

/**
 * The module as the registry and dashboard see it, with nothing bound.
 *
 * Registering this is safe but inert: with no blocklist store the listener
 * cannot check anything, and it says exactly that — naming `RedisBlocklistStore`
 * and the constructor call — the first time a message containing a link arrives
 * in a guild that has the module on. Silence is the one outcome ruled out.
 */
export const phishingModule: ModuleManifest<typeof phishingConfigSchema> = createPhishingModule();

export default phishingModule;
