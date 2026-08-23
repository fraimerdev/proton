import { protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const verificationConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, { label: 'Enabled' }),

  unverifiedRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Unverified role',
    description: 'New members are briefly ungated until Proton applies it',
  }),

  verifiedRoleId: snowflakeSchema
    .optional()
    .register(protonFields, { field: 'role-id', label: 'Member role' }),

  applyUnverifiedOnJoin: z
    .boolean()
    .default(true)
    .register(protonFields, { label: 'Apply the unverified role on join' }),

  quarantineRoleId: snowflakeSchema
    .optional()
    .register(protonFields, { field: 'role-id', label: 'Quarantine role' }),
});

export type VerificationConfig = z.infer<typeof verificationConfigSchema>;

export const verificationDefaultConfig: VerificationConfig = {
  enabled: false,
  applyUnverifiedOnJoin: true,
};

export const VERIFICATION_SCHEMA_VERSION = 1;
