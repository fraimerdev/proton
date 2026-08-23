import { durationStringSchema, MESSAGE_CACHE_DEFAULT_TTL_MS, protonFields } from '@proton/core';
import { z } from 'zod';

export const MESSAGE_LOG_RETENTION_DAYS = 30;

export const MESSAGE_CACHE_DEFAULT_RETENTION = '24h';

export const loggingConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Enabled',
      description: `Stores message content — personal data — for ${MESSAGE_LOG_RETENTION_DAYS} days`,
    }),

  logEdits: z.boolean().default(true).register(protonFields, {
    label: 'Log edits',
  }),

  logDeletes: z.boolean().default(true).register(protonFields, {
    label: 'Log deletions',
  }),

  ignoredChannels: z
    .array(z.string())
    .max(50)
    .default([])
    .register(protonFields, {
      field: 'channel-id',
      label: 'Ignored channels',

      channelTypes: [0, 5, 11, 12],
    }),

  cacheMessageContent: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Remember recent message text',
      description: `Personal data, held in memory apart from the ${MESSAGE_LOG_RETENTION_DAYS}-day archive`,
    }),

  cacheRetention: durationStringSchema
    .default(MESSAGE_CACHE_DEFAULT_RETENTION)
    .register(protonFields, {
      field: 'duration',
      label: 'How long to remember',
    }),
});

export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

export const loggingDefaultConfig: LoggingConfig = {
  enabled: false,
  logEdits: true,
  logDeletes: true,
  ignoredChannels: [],
  cacheMessageContent: false,
  cacheRetention: MESSAGE_CACHE_DEFAULT_RETENTION,
};

// Bumped for the message-content cache. No SQL migration: the new keys carry defaults, so
// ModuleConfigService.get() fills them in when it parses an existing row.
export const LOGGING_SCHEMA_VERSION = 2;

export const MESSAGE_CACHE_FALLBACK_TTL_MS = MESSAGE_CACHE_DEFAULT_TTL_MS;
