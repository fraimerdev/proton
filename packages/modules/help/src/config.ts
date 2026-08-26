import { protonFields } from '@proton/core';
import { z } from 'zod';

export const MODULE_ID = 'help';

export const helpConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
  }),

  ephemeral: z.boolean().default(true).register(protonFields, {
    label: 'Show the reply only to whoever ran it',
    description: 'Turn this off to post the overview into the channel, where everyone can read it.',
  }),
});

export type HelpConfig = z.infer<typeof helpConfigSchema>;

export const helpDefaultConfig: HelpConfig = {
  enabled: true,
  ephemeral: true,
};

export const HELP_SCHEMA_VERSION = 1;
