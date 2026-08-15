import { durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';

export const PHISHING_ACTIONS = ['none', 'timeout', 'kick', 'ban'] as const;
export type PhishingAction = (typeof PHISHING_ACTIONS)[number];

const GUILD_LIST_MAX = 100;

export const phishingConfigSchema = z.object({
  enabled: z
    .boolean()
    .default(true)
    .register(protonFields, {
      label: 'Enabled',
      description:
        'Check messages against the community phishing blocklist. On by default — a scam ' +
        'link is acted on within seconds of being posted, which is the whole value.',
    }),

  action: z
    .enum(PHISHING_ACTIONS)
    .default('timeout')
    .register(protonFields, {
      label: 'Action',
      description:
        'What happens to whoever posted the link. Timeout is the default because it stops ' +
        'the spam immediately and lifts itself, so a false positive costs an hour rather ' +
        'than a ban appeal. Choose None to alert staff without acting.',
    }),

  timeoutDuration: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'Timeout length',
    description: 'How long the timeout lasts. Discord caps timeouts at 28 days.',
  }),

  alertChannel: z
    .string()
    .optional()
    .register(protonFields, {
      field: 'channel-id',
      label: 'Alert channel',
      description:
        'Posts the channel, the author and the exact domain that matched, so staff can ' +
        'check the call. Leave empty for no alert.',

      channelTypes: [0, 5, 11, 12],
    }),

  blockDomains: z
    .array(z.string().max(253))
    .max(GUILD_LIST_MAX)
    .default([])
    .register(protonFields, {
      label: 'Extra blocked domains',
      description:
        'Blocked in this server on top of the community list. An entry also covers its ' +
        'subdomains, so blocking example.com also blocks login.example.com.',
    }),

  allowDomains: z
    .array(z.string().max(253))
    .max(GUILD_LIST_MAX)
    .default([])
    .register(protonFields, {
      label: 'Never blocked',
      description:
        'Checked before the blocklist, so these are never acted on even if a feed lists ' +
        'them. Also covers subdomains.',
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
