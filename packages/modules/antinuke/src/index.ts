import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createAntinukeCommands } from './commands.ts';
import { ANTINUKE_SCHEMA_VERSION, antinukeConfigSchema, antinukeDefaultConfig } from './config.ts';
import type { AntinukeDeps } from './deps.ts';
import { createAntinukeListener } from './listeners.ts';

export {
  ANTINUKE_ACTOR,
  type BreakerInput,
  type BreakerReport,
  MODULE_ID,
  tripBreaker,
} from './breaker.ts';
export {
  CLASS_LABELS,
  CLASS_OF_EVENT,
  classOfEvent,
  NUKE_CLASSES,
  type NukeClass,
  type Threshold,
  thresholdFor,
  WATCHED_EVENT_TYPES,
  type WatchedEventType,
} from './classes.ts';
export { createAntinukeCommands } from './commands.ts';
export {
  AFTER_STRIP_ACTIONS,
  type AfterStripAction,
  ANTINUKE_SCHEMA_VERSION,
  type AntinukeConfig,
  antinukeConfigSchema,
  antinukeDefaultConfig,
} from './config.ts';
export {
  type AntinukeDeps,
  type BindResult,
  type BoundAntinukeDeps,
  bindDeps,
  describeUnbound,
} from './deps.ts';
export {
  type AntinukeOutcome,
  announceLapse,
  createAntinukeListener,
  handleDestructiveEvent,
} from './listeners.ts';
export {
  hasLapsed,
  isCoveredByMaintenance,
  isMaintenanceRefusal,
  MAINTENANCE_GRACE_MS,
  MAINTENANCE_PREFIX,
  type MaintenancePlanInput,
  type MaintenanceRefusal,
  type MaintenanceStore,
  type MaintenanceWindow,
  maintenanceKey,
  maintenanceWindowSchema,
  planMaintenance,
  RedisMaintenanceStore,
} from './maintenance.ts';

/**
 * Anti-nuke (PLAN.md §8 phase 2, and the headline of Gate 2).
 *
 * A factory rather than a constant for the same reason `createLoggingModule` is
 * one: §7's `ModuleContext` hands a module a guild id, its config, an executor
 * and a logger, and this module additionally needs a sliding-window counter, a
 * place to keep the maintenance flag, the guild snapshot, a single-member role
 * lookup and Proton's own user id. Those are declared as ports in
 * `AntinukeDeps` and bound by whatever process runs modules; when the framework
 * grows a context port for them, this becomes an ordinary constant.
 *
 * What it does, in §8's order: count destructive audit-log events per actor in
 * a sliding window, and when one crosses its threshold **strip that member's
 * roles first** and investigate after. Stripping is instant and exactly
 * reversible — every removal carries the full role set into the case ledger — so
 * it is what buys the time. Anything irreversible is opt-in and happens strictly
 * afterwards.
 *
 * What it deliberately does not do: stop the guild owner. §15 is blunt that you
 * cannot, so the breaker says so loudly instead of issuing calls Discord will
 * refuse one at a time.
 *
 * Remaining limitations, all in the framework and all outside a module's remit.
 * The listener itself is live: `apps/worker`'s `ModuleListenerRuntime` drives
 * `manifest.listeners` on its own consumer group, and `apps/worker/src/index.ts`
 * binds every port below.
 *
 *  1. `ModuleContext` has no storage, identity or lookup ports, hence the
 *     factory above. A module cannot reach Redis, cannot ask who it is, and
 *     cannot read a member's roles.
 *  2. There is no ledger-only action kind (a `note`, or `cases`' missing
 *     `warn`), so switching maintenance mode on is audited by the case its
 *     ephemeral reply records plus a warn-level log line, rather than by a case
 *     of its own. Recording one outside the executor would violate I1.
 *  3. This module declares no `manifest.jobs`, so the "maintenance window
 *     lapsed" notice is still raised by the next destructive event rather than
 *     by a timer. A runner now exists, so this is a choice rather than a
 *     blocker: the notice is idempotent on the window's expiry, so whichever
 *     path notices first the guild is told exactly once, and a per-guild timer
 *     would cost a scheduled job per guild to say the same thing.
 *  4. A listener is handed the unscoped executor — it has no `app_permissions`
 *     and may act on a channel other than the event's — so a channel overwrite
 *     denying SEND_MESSAGES in the alert channel surfaces as Discord's 403
 *     rather than as a named precheck failure. See `announce` in `breaker.ts`.
 */
export function createAntinukeModule(
  deps: AntinukeDeps = {},
): ModuleManifest<typeof antinukeConfigSchema> {
  return {
    id: 'antinuke',
    name: 'Anti-nuke',
    category: 'security',
    configSchema: antinukeConfigSchema,
    defaultConfig: antinukeDefaultConfig,
    schemaVersion: ANTINUKE_SCHEMA_VERSION,

    /**
     * GUILD_MODERATION (1<<2) carries GUILD_AUDIT_LOG_ENTRY_CREATE, which is the
     * only dispatch that names who performed a destructive act. It is not
     * privileged, so there is no portal toggle to forget — but without it this
     * module reads an empty stream and protects nothing.
     */
    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration],

    /**
     * Two hard requirements, and only two.
     *
     * VIEW_AUDIT_LOG because Discord sends the audit dispatch to nobody without
     * it — the module is blind, not degraded, when it is missing. MANAGE_ROLES
     * because stripping roles is the response, and a breaker that can detect but
     * not act is worse than no breaker: it reports an attack it did nothing
     * about.
     *
     * Not BAN_MEMBERS or KICK_MEMBERS, even though `afterStrip` can ask for
     * both. `requiredPermissions` is a hard gate that disables the module
     * outright, and gating a security control on ban rights would leave the
     * servers that never grant them with no anti-nuke at all. A configured
     * `afterStrip` the bot cannot perform fails at the executor's precheck
     * instead, which names the missing permission and where (I8) — the right
     * layer for a per-response requirement. Likewise SEND_MESSAGES: the alert
     * channel is optional, and its absence must not disable detection.
     */
    requiredPermissions: [Permissions.ViewAuditLog, Permissions.ManageRoles],

    commands: createAntinukeCommands(deps),
    listeners: [createAntinukeListener(deps)],
    migrations: [],

    dashboard: {
      icon: 'shield-alert',
      sections: [
        {
          id: 'general',
          title: 'General',
          fields: ['enabled', 'afterStrip', 'alertChannelId'],
        },
        {
          id: 'thresholds',
          title: 'Thresholds',
          fields: [
            'channelDeleteLimit',
            'channelDeleteWindow',
            'roleDeleteLimit',
            'roleDeleteWindow',
            'webhookDeleteLimit',
            'webhookDeleteWindow',
            'emojiDeleteLimit',
            'emojiDeleteWindow',
            'memberRemoveLimit',
            'memberRemoveWindow',
          ],
        },
        {
          id: 'maintenance',
          title: 'Maintenance mode',
          fields: ['maintenanceMaxDuration'],
        },
      ],
    },
  };
}

/**
 * The module as the registry and dashboard see it, with nothing bound.
 *
 * Registrable and renderable, and honest about being inert: the first
 * destructive event in a guild that has anti-nuke enabled logs an error naming
 * every unbound port and the exact construction that fixes it, rather than
 * leaving a server to believe it is protected.
 */
export const antinukeModule: ModuleManifest<typeof antinukeConfigSchema> = createAntinukeModule();

export default antinukeModule;
