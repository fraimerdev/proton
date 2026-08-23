import { durationStringSchema, protonFields } from '@proton/core';
import { z } from 'zod';

const ALERT_CHANNEL_TYPES = [0, 5];

function limitField(label: string, defaultValue: number) {
  return z.number().int().min(2).max(100).default(defaultValue).register(protonFields, { label });
}

function windowField(label: string, defaultValue: string) {
  return durationStringSchema
    .default(defaultValue)
    .register(protonFields, { field: 'duration', label });
}

export const AFTER_STRIP_ACTIONS = ['none', 'kick', 'ban'] as const;

export type AfterStripAction = (typeof AFTER_STRIP_ACTIONS)[number];

export const antinukeConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, { label: 'Enabled' }),

  channelDeleteLimit: limitField('Channel deletions per member', 3),
  channelDeleteWindow: windowField('Channel deletion window', '30s'),

  roleDeleteLimit: limitField('Role deletions per member', 3),
  roleDeleteWindow: windowField('Role deletion window', '30s'),

  webhookDeleteLimit: limitField('Webhook deletions per member', 5),
  webhookDeleteWindow: windowField('Webhook deletion window', '30s'),

  emojiDeleteLimit: limitField('Emoji deletions per member', 10),
  emojiDeleteWindow: windowField('Emoji deletion window', '1m'),

  memberRemoveLimit: limitField('Bans and kicks per moderator', 5),
  memberRemoveWindow: windowField('Ban and kick window', '30s'),

  afterStrip: z.enum(AFTER_STRIP_ACTIONS).default('none').register(protonFields, {
    label: 'After stripping roles',
    description: 'Roles are stripped first whatever this is set to',
  }),

  alertChannelId: z.string().optional().register(protonFields, {
    field: 'channel-id',
    label: 'Alert channel',
    channelTypes: ALERT_CHANNEL_TYPES,
  }),

  maintenanceMaxDuration: durationStringSchema.default('1h').register(protonFields, {
    field: 'duration',
    label: 'Longest maintenance window',
    description: 'Maintenance leaves the server unguarded for this long',
  }),
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
