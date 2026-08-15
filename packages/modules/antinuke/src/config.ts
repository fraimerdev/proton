import { durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';

const ALERT_CHANNEL_TYPES = [0, 5];

function limitField(label: string, description: string, defaultValue: number) {
  return z
    .number()
    .int()
    .min(2)
    .max(100)
    .default(defaultValue)
    .register(protonFields, { label, description });
}

function windowField(label: string, description: string, defaultValue: string) {
  return durationStringSchema
    .default(defaultValue)
    .register(protonFields, { field: 'duration', label, description });
}

export const AFTER_STRIP_ACTIONS = ['none', 'kick', 'ban'] as const;

export type AfterStripAction = (typeof AFTER_STRIP_ACTIONS)[number];

export const antinukeConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
    description: 'Watch the audit log for destructive bursts and trip the breaker.',
  }),

  channelDeleteLimit: limitField(
    'Channel deletions before the breaker trips',
    'How many channels one member may delete inside the window below.',
    3,
  ),
  channelDeleteWindow: windowField(
    'Channel deletion window',
    'The period the deletions above are counted over.',
    '30s',
  ),

  roleDeleteLimit: limitField(
    'Role deletions before the breaker trips',
    'How many roles one member may delete inside the window below.',
    3,
  ),
  roleDeleteWindow: windowField(
    'Role deletion window',
    'The period the deletions above are counted over.',
    '30s',
  ),

  webhookDeleteLimit: limitField(
    'Webhook deletions before the breaker trips',
    'How many webhooks one member may delete inside the window below.',
    5,
  ),
  webhookDeleteWindow: windowField(
    'Webhook deletion window',
    'The period the deletions above are counted over.',
    '30s',
  ),

  emojiDeleteLimit: limitField(
    'Emoji deletions before the breaker trips',
    'How many emoji one member may delete inside the window below. Emoji are cosmetic and ' +
      'are often tidied in bulk, so this is deliberately looser than the others.',
    10,
  ),
  emojiDeleteWindow: windowField(
    'Emoji deletion window',
    'The period the deletions above are counted over.',
    '1m',
  ),

  memberRemoveLimit: limitField(
    'Bans and kicks before the breaker trips',
    'How many members one moderator may ban or kick inside the window below. Bans and kicks ' +
      'share one counter: they empty a server equally well, and two separate limits would let ' +
      'someone alternate between them and stay under both.',
    5,
  ),
  memberRemoveWindow: windowField(
    'Ban and kick window',
    'The period the bans and kicks above are counted over.',
    '30s',
  ),

  afterStrip: z
    .enum(AFTER_STRIP_ACTIONS)
    .default('none')
    .register(protonFields, {
      label: 'After stripping roles',
      description:
        'What to do once the roles are off. Stripping always happens first — it is instant ' +
        'and reversible. Anything here is not.',
    }),

  alertChannelId: z
    .string()
    .optional()
    .register(protonFields, {
      field: 'channel-id',
      label: 'Alert channel',
      description:
        'Where the breaker reports what it did. Leave empty and the report only reaches the ' +
        'logs — somebody has to be told, because the breaker stops the bleeding and a human ' +
        'still has to investigate.',
      channelTypes: ALERT_CHANNEL_TYPES,
    }),

  maintenanceMaxDuration: windowField(
    'Longest maintenance window',
    'The most time /antinuke maintenance may switch the breaker off for in one go.',
    '1h',
  ),
});

export type AntinukeConfig = z.infer<typeof antinukeConfigSchema>;

export const antinukeDefaultConfig: AntinukeConfig = {
  enabled: true,
  channelDeleteLimit: 3,
  channelDeleteWindow: '30s',
  roleDeleteLimit: 3,
  roleDeleteWindow: '30s',
  webhookDeleteLimit: 5,
  webhookDeleteWindow: '30s',
  emojiDeleteLimit: 10,
  emojiDeleteWindow: '1m',
  memberRemoveLimit: 5,
  memberRemoveWindow: '30s',
  afterStrip: 'none',

  maintenanceMaxDuration: '1h',
};

export const ANTINUKE_SCHEMA_VERSION = 1;
