import { protonFields } from '@proton/core';
import { z } from 'zod';

export const casesConfigSchema = z.object({
  enabled: z.boolean().default(true).register(protonFields, {
    label: 'Enabled',
  }),
});

export type CasesConfig = z.infer<typeof casesConfigSchema>;

export const casesDefaultConfig: CasesConfig = {
  enabled: true,
};

export const CASES_SCHEMA_VERSION = 2;
