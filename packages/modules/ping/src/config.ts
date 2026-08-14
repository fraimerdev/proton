import { protonFields } from '@proton/core';
import { z } from 'zod';

/**
 * Ping's configuration.
 *
 * Shaped so all three Gate 0 field types are load-bearing rather than merely
 * demonstrated: the vertical slice cannot pass unless boolean, string and
 * channel-id all render and round-trip.
 */
export const pingConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
    description: 'Respond to /ping in this server.',
  }),

  response: z.string().min(1).max(200).default('Pong!').register(protonFields, {
    label: 'Reply text',
    description: 'What the bot replies with. 1-200 characters.',
  }),

  restrictToChannel: z
    .string()
    .nullable()
    .default(null)
    .register(protonFields, {
      field: 'channel-id',
      label: 'Restrict to channel',
      description: 'If set, /ping only answers in this channel.',
      channelTypes: [0],
    }),
});

export type PingConfig = z.infer<typeof pingConfigSchema>;

export const pingDefaultConfig: PingConfig = {
  enabled: true,
  response: 'Pong!',
  restrictToChannel: null,
};

/** Bumped whenever the shape above changes (I5). */
export const PING_SCHEMA_VERSION = 1;
