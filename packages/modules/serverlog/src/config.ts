import { protonFields } from '@proton/core';
import { z } from 'zod';
import { isLogEventKey, LOG_CATEGORIES } from './catalogue.ts';

export const SERVERLOG_SCHEMA_VERSION = 1;

export const LOG_TEXT_CHANNEL_TYPES = [0, 5];

const CHANNEL_REF = /^(\d{17,20})?$/;

// A plain string with a permissive pattern, not a union with z.literal(''): the v1 form generator
// builds a channel picker from ZodString only, and rejects a union outright.
const channelRef = () =>
  z.string().regex(CHANNEL_REF, 'must be a Discord channel id, or empty to inherit').default('');

const categoryChannel = (label: string) =>
  channelRef().register(protonFields, {
    field: 'channel-id',
    label,
    channelTypes: LOG_TEXT_CHANNEL_TYPES,
  });

const categoryToggle = (label: string, on: boolean) =>
  z.boolean().default(on).register(protonFields, { label });

// Two parallel one-level objects rather than one two-level object: the form generator walks a
// top-level ZodObject but refuses to nest twice.
const categoryChannelsShape = z.object({
  server: categoryChannel('Server'),
  channels: categoryChannel('Channels'),
  roles: categoryChannel('Roles'),
  members: categoryChannel('Members'),
  messages: categoryChannel('Messages'),
  voice: categoryChannel('Voice'),
  moderation: categoryChannel('Moderation'),
  invites: categoryChannel('Invites'),
  integrations: categoryChannel('Integrations'),
  expressions: categoryChannel('Emoji & stickers'),
  events: categoryChannel('Events & stages'),
  automod: categoryChannel('AutoMod'),
  proton: categoryChannel('Proton'),
});

const categoriesShape = z.object({
  server: categoryToggle('Server', true),
  channels: categoryToggle('Channels', true),
  roles: categoryToggle('Roles', true),
  members: categoryToggle('Members', true),
  messages: categoryToggle('Messages', false),
  voice: categoryToggle('Voice', false),
  moderation: categoryToggle('Moderation', true),
  invites: categoryToggle('Invites', true),
  integrations: categoryToggle('Integrations', true),
  expressions: categoryToggle('Emoji & stickers', true),
  events: categoryToggle('Events & stages', true),
  automod: categoryToggle('AutoMod', true),
  proton: categoryToggle('Proton', true),
});

export const logEventOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  channelId: z.string().regex(CHANNEL_REF, 'must be a Discord channel id').optional(),
});

export type LogEventOverride = z.infer<typeof logEventOverrideSchema>;

export const serverlogConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Post an embed to a log channel when things change in this server.',
  }),

  defaultChannelId: channelRef().register(protonFields, {
    field: 'channel-id',
    label: 'Default log channel',
    description: 'Every log lands here unless a category or a single event points somewhere else.',
    channelTypes: LOG_TEXT_CHANNEL_TYPES,
  }),

  // The default is parsed from the shape rather than written out: `{}` is the input, but
  // `.default()` takes the output, and every field in here carries its own default.
  categoryChannels: categoryChannelsShape.default(categoryChannelsShape.parse({})),

  categories: categoriesShape.default(categoriesShape.parse({})),

  events: z
    .record(z.string(), logEventOverrideSchema)
    .default({})
    .superRefine((value, ctx) => {
      for (const key of Object.keys(value)) {
        if (isLogEventKey(key)) continue;

        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `'${key}' is not a log Proton knows about — it was probably renamed. Remove it.`,
        });
      }
    }),

  ignoredChannelIds: z
    .array(z.string().regex(/^\d{17,20}$/, 'must be a Discord channel id'))
    .max(100)
    .default([])
    .register(protonFields, {
      field: 'channel-id',
      label: 'Ignored channels',
      description: 'Nothing that happens in these channels is ever logged.',
    }),

  ignoredRoleIds: z
    .array(z.string().regex(/^\d{17,20}$/, 'must be a Discord role id'))
    .max(50)
    .default([])
    .register(protonFields, {
      field: 'role-id',
      label: 'Ignored roles',
      description: 'Anything done by someone holding one of these roles is never logged.',
    }),

  ignoredUserIds: z
    .array(z.string().regex(/^\d{17,20}$/, 'must be a Discord user id'))
    .max(100)
    .default([])
    .register(protonFields, {
      label: 'Ignored user ids',
      description: 'Anything done by these users is never logged. Paste Discord user ids.',
    }),

  ignoreBots: z.boolean().default(false).register(protonFields, {
    label: 'Ignore bots',
    description: 'Skip anything done by a bot. Proton’s own log posts are always skipped.',
  }),
});

export type ServerlogConfig = z.infer<typeof serverlogConfigSchema>;

// `events` is a record, which the v1 form generator cannot render — the dashboard ships a bespoke
// matrix for it, so the generated form is built from everything else.
export const serverlogFormSchema = serverlogConfigSchema.omit({ events: true });

export const serverlogDefaultConfig: ServerlogConfig = serverlogConfigSchema.parse({});

export const LOG_CATEGORY_KEYS = LOG_CATEGORIES;
