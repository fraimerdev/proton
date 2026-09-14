import { protonFields } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'help';

export const helpConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
  }),

  ephemeral: z.boolean().default(true).register(protonFields, {
    label: 'Reply privately',
    description: 'Only the member who used /help sees the reply.',
  }),
});

export type HelpConfig = z.infer<typeof helpConfigSchema>;

export const helpDefaultConfig: HelpConfig = {
  enabled: true,
  ephemeral: true,
};

export const HELP_SCHEMA_VERSION = 1;
