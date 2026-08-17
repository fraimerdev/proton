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
      description:
        `Record message edits and deletions in this server for ${MESSAGE_LOG_RETENTION_DAYS} days. ` +
        'Off until you turn it on — stored message content is personal data you are responsible for.',
    }),

  logEdits: z.boolean().default(true).register(protonFields, {
    label: 'Log edits',
    description: 'Record the new text when a member edits a message.',
  }),

  logDeletes: z.boolean().default(true).register(protonFields, {
    label: 'Log deletions',
    description: 'Record which message was deleted, in which channel, and when.',
  }),

  ignoredChannels: z
    .array(z.string())
    .max(50)
    .default([])
    .register(protonFields, {
      field: 'channel-id',
      label: 'Ignored channels',
      description: 'Edits and deletions in these channels are never recorded.',

      channelTypes: [0, 5, 11, 12],
    }),

  cacheMessageContent: z
    .boolean()
    .default(false)
    .register(protonFields, {
      label: 'Remember recent message text',
      description:
        'Keep the text of recent messages in memory so edit logs can show what changed, and delete ' +
        'logs can show what was removed and who wrote it. Off until you turn it on — this is ' +
        'personal data, and it is held separately from the 30-day archive above.',
    }),

  cacheRetention: durationStringSchema
    .default(MESSAGE_CACHE_DEFAULT_RETENTION)
    .register(protonFields, {
      field: 'duration',
      label: 'How long to remember',
      description: 'Between 1 hour and 7 days. Held in memory only — nothing is written to disk.',
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
