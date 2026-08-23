import { durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';

export const PHISHING_ACTIONS = ['none', 'timeout', 'kick', 'ban'] as const;
export type PhishingAction = (typeof PHISHING_ACTIONS)[number];

const GUILD_LIST_MAX = 100;

export const phishingConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
  }),

  action: z.enum(PHISHING_ACTIONS).default('timeout').register(protonFields, {
    label: 'Action',
    description: 'The message itself is never deleted',
  }),

  timeoutDuration: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'Timeout length',
    description: 'Discord caps timeouts at 28 days',
  }),

  alertChannel: z
    .string()
    .optional()
    .register(protonFields, {
      field: 'channel-id',
      label: 'Alert channel',

      channelTypes: [0, 5, 11, 12],
    }),

  blockDomains: z
    .array(z.string().max(253))
    .max(GUILD_LIST_MAX)
    .default([])
    .register(protonFields, {
      label: 'Extra blocked domains',
    }),

  allowDomains: z
    .array(z.string().max(253))
    .max(GUILD_LIST_MAX)
    .default([])
    .register(protonFields, {
      label: 'Never blocked',
      description: 'Also allows every subdomain',
    }),
});

export type PhishingConfig = z.infer<typeof phishingConfigSchema>;

export const phishingDefaultConfig: PhishingConfig = {
  enabled: true,
  action: 'timeout',
  timeoutDuration: '1h',
  blockDomains: [],
  allowDomains: [],
};

export const PHISHING_SCHEMA_VERSION = 1;
