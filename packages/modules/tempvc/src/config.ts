import { protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'tempvc';

export const CHANNEL_NAME_MAX = 100;

export const HUBS_CEILING = 40;

export const OWNER_PLACEHOLDER = '{user}';

export const VOICE_CHANNEL_TYPE = 2;

export const DEFAULT_NAME_TEMPLATE = `${OWNER_PLACEHOLDER}’s channel`;

export const tempVcHubSchema = z.object({
  channelId: snowflakeSchema,

  categoryId: snowflakeSchema.optional(),

  nameTemplate: z
    .string()
    .min(1)
    .max(CHANNEL_NAME_MAX)
    .default(DEFAULT_NAME_TEMPLATE)
    .refine((value) => value.includes(OWNER_PLACEHOLDER), {
      message: `a hub name template needs ${OWNER_PLACEHOLDER} in it, or every channel it makes has the same name.`,
    }),

  userLimit: z.number().int().min(0).max(99).default(0),

  bitrate: z.number().int().min(8_000).max(384_000).optional(),
});

export type TempVcHub = z.infer<typeof tempVcHubSchema>;

export const tempVcHubsSchema = z
  .array(tempVcHubSchema)
  .max(HUBS_CEILING)
  .default([])
  .superRefine((hubs, ctx) => {
    const seen = new Set<string>();

    for (const [index, hub] of hubs.entries()) {
      if (seen.has(hub.channelId)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'channelId'],
          message: 'two hubs cannot watch the same channel — the second one would never be used.',
        });
      }
      seen.add(hub.channelId);
    }
  });

const settings = {
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Does nothing until at least one hub is added',
  }),

  ownerCommands: z.boolean().default(true).register(protonFields, {
    label: 'Let owners manage their own channel',
  }),
};

export const tempVcConfigSchema = z.object({
  ...settings,

  hubs: tempVcHubsSchema,
});

// The form generator refuses arrays of objects by design (PLAN.md §9), so the hub list is edited
// by a bespoke dashboard panel and omitted here rather than crashing the settings page.
export const tempVcFormSchema = z.object(settings);

export type TempVcConfig = z.infer<typeof tempVcConfigSchema>;

export const tempVcDefaultConfig: TempVcConfig = {
  enabled: false,
  ownerCommands: true,
  hubs: [],
};

export const TEMPVC_SCHEMA_VERSION = 1;

export function hubFor(config: TempVcConfig, channelId: string | null): TempVcHub | undefined {
  if (channelId === null) return undefined;
  return config.hubs.find((hub) => hub.channelId === channelId);
}

export function renderChannelName(template: string, owner: string): string {
  return template.split(OWNER_PLACEHOLDER).join(owner).slice(0, CHANNEL_NAME_MAX);
}
