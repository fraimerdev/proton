import { protonFields } from '@proton/core';
import { z } from 'zod';

export const pingConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
  }),

  response: z.string().min(1).max(200).default('Pong!').register(protonFields, {
    label: 'Reply text',
  }),

  restrictToChannel: z
    .string()
    .nullable()
    .default(null)
    .register(protonFields, {
      field: 'channel-id',
      label: 'Restrict to channel',
      channelTypes: [0],
    }),
});

export type PingConfig = z.infer<typeof pingConfigSchema>;

export const pingDefaultConfig: PingConfig = {
  enabled: true,
  response: 'Pong!',
  restrictToChannel: null,
};

export const PING_SCHEMA_VERSION = 1;
