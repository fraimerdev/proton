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
  MESSAGE_CACHE_DEFAULT_RETENTION,
  MESSAGE_CACHE_FALLBACK_TTL_MS,
  MESSAGE_LOG_RETENTION_DAYS,
} from './config.ts';
export { type CachedMessages, messageIdsOf, toMessageLogEntries } from './events.ts';
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

    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],

    requiredPermissions: [Permissions.ViewChannel],

    listeners: [createMessageLogListener(deps)],

    jobs: [
      {
        id: PARTITION_MAINTENANCE_JOB_ID,

        cron: PARTITION_MAINTENANCE_CRON,
        payload: { retentionDays: MESSAGE_LOG_RETENTION_DAYS, lookaheadDays: 1 },
      },
    ],

    dashboard: {
      icon: 'scroll-text',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'logEdits', 'logDeletes'] },
        {
          id: 'cache',
          title: 'Recent message text',
          fields: ['cacheMessageContent', 'cacheRetention'],
        },
        { id: 'privacy', title: 'Privacy', fields: ['ignoredChannels'] },
      ],
    },
  };
}

export const loggingModule: ModuleManifest<typeof loggingConfigSchema> = createLoggingModule();

export default loggingModule;
