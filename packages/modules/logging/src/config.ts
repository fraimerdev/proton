import { protonFields } from '@proton/core';
import { z } from 'zod';

export const MESSAGE_LOG_RETENTION_DAYS = 30;

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
});

export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

export const loggingDefaultConfig: LoggingConfig = {
  enabled: false,
  logEdits: true,
  logDeletes: true,
  ignoredChannels: [],
};

export const LOGGING_SCHEMA_VERSION = 1;
