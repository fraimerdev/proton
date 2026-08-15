import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  LOGGING_SCHEMA_VERSION,
  loggingConfigSchema,
  loggingDefaultConfig,
  MESSAGE_LOG_RETENTION_DAYS,
} from './config.ts';
import { createMessageLogListener, type LoggingDeps } from './listeners.ts';
import { PARTITION_MAINTENANCE_CRON, PARTITION_MAINTENANCE_JOB_ID } from './maintenance.ts';

export {
  LOGGING_SCHEMA_VERSION,
  type LoggingConfig,
  loggingConfigSchema,
  loggingDefaultConfig,
  MESSAGE_LOG_RETENTION_DAYS,
} from './config.ts';
export { toMessageLogEntries } from './events.ts';
export {
  createMessageLogListener,
  LOGGED_EVENT_TYPES,
  type LoggingDeps,
} from './listeners.ts';
export {
  type MaintenanceOptions,
  type MaintenancePayload,
  type MaintenanceResult,
  maintenancePayloadSchema,
  PARTITION_MAINTENANCE_CRON,
  PARTITION_MAINTENANCE_JOB_ID,
  runMessageLogMaintenance,
} from './maintenance.ts';
export {
  addDays,
  isPartitionName,
  PARTITION_PREFIX,
  partitionDay,
  partitionName,
  partitionRange,
  partitionsToDrop,
  partitionsToEnsure,
  retentionCutoff,
  utcDayStart,
} from './partitions.ts';
export { PostgresMessageLogStore } from './postgres-store.ts';
export type { MessageLogEntry, MessageLogKind, MessageLogStore } from './store.ts';
export { type MessageLogRow, messageLogs, type NewMessageLogRow } from './table.ts';

/**
 * Message edit/delete logging (PLAN.md §8 phase 1; Gate 1's "message edit/delete
 * logging behind per-guild opt-in with TTL").
 *
 * A factory rather than a constant because the module needs somewhere to write,
 * and §7's `ModuleContext` has no storage port — a module owns its own tables but
 * cannot be handed a connection to them. Injecting the store at construction
 * keeps that dependency explicit and the handlers testable; when the framework
 * grows a port, this becomes an ordinary constant.
 *
 * This module was dead on arrival for its whole first phase, in a way nothing
 * detected: all three of the event types it subscribes to were declared in
 * `EVENT_TYPES` and emitted by nothing, so its listener could never fire while
 * every one of its tests passed. Both halves are now closed — the normaliser has
 * MESSAGE_UPDATE, MESSAGE_DELETE and MESSAGE_DELETE_BULK arms, and
 * `packages/modules/registry`'s test asserts every manifest's listener types
 * against the set the normaliser actually emits, so the failure cannot recur
 * silently.
 *
 * One limitation remains, and it is not a blocker: nothing runs
 * `manifest.migrations`. The table therefore ships in the core migration set as
 * `packages/db/drizzle/0002_message_logs.sql`, hand-written because drizzle-kit
 * cannot express `PARTITION BY`. Listing it here as well would be two copies of
 * the same DDL with no mechanism to keep them equal.
 */
export function createLoggingModule(
  deps: LoggingDeps = {},
): ModuleManifest<typeof loggingConfigSchema> {
  return {
    id: 'logging',
    name: 'Message logs',
    category: 'logging',
    configSchema: loggingConfigSchema,
    defaultConfig: loggingDefaultConfig,
    schemaVersion: LOGGING_SCHEMA_VERSION,

    /**
     * MESSAGE_CONTENT is privileged and the module is useless without it: Discord
     * blanks `content` on MESSAGE_UPDATE when it is not granted, so every edit
     * would be recorded as an empty string and the log would quietly lie.
     * Declaring it means the registry disables the module with the intent named
     * and the portal toggle to flip, instead of a guild discovering it one
     * meaningless log entry at a time (§7).
     */
    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],

    /**
     * VIEW_CHANNEL only. It is the permission that decides whether message events
     * reach the bot at all, and it is a hard gate — the registry disables the
     * module when it is missing. Nothing here posts, so SEND_MESSAGES would
     * disable logging in servers that never intended the bot to talk.
     */
    requiredPermissions: [Permissions.ViewChannel],

    listeners: [createMessageLogListener(deps)],

    jobs: [
      {
        id: PARTITION_MAINTENANCE_JOB_ID,
        // No timezone: partitions are UTC days, so the job that rolls them must
        // be too. A local-time schedule would create the wrong day twice a year.
        cron: PARTITION_MAINTENANCE_CRON,
        payload: { retentionDays: MESSAGE_LOG_RETENTION_DAYS, lookaheadDays: 1 },
      },
    ],

    // See blocker 4: the DDL lives in packages/db/drizzle/0002_message_logs.sql.
    migrations: [],

    dashboard: {
      icon: 'scroll-text',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'logEdits', 'logDeletes'] },
        { id: 'privacy', title: 'Privacy', fields: ['ignoredChannels'] },
      ],
    },
  };
}

/**
 * The module as the registry and dashboard see it, with no store bound.
 *
 * Safe because `enabled` defaults to false: a guild that has not opted in
 * produces no entries at all. A guild that has opted in gets an error naming
 * exactly what is unwired rather than silence, which is the failure mode §1 and
 * §7 exist to eliminate.
 */
export const loggingModule: ModuleManifest<typeof loggingConfigSchema> = createLoggingModule();

export default loggingModule;
