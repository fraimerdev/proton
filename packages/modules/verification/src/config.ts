import { protonFields, snowflakeSchema } from '@proton/core';
import { z } from 'zod';

export const verificationConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Gate new members behind a role, and allow /quarantine.',
  }),

  unverifiedRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Unverified role',
    description:
      'The restricted role a member holds until they pass the gate. Prefer granting it with ' +
      'a role-granting invite (Server Settings → Invites): Discord applies it at the moment ' +
      'of joining, so there is no window in which the member is ungated. Proton detects that ' +
      'and stays out of the way.',
  }),

  verifiedRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Member role',
    description:
      'Granted when a member passes the gate. Leave empty if removing the unverified role ' +
      'is itself the grant — Proton needs at least one of the two roles to be set.',
  }),

  applyUnverifiedOnJoin: z
    .boolean()
    .default(true)
    .register(protonFields, {
      label: 'Apply the unverified role on join',
      description:
        'Only used when the invite did not already grant it. Turn this off if every invite ' +
        'to this server is a role-granting one; Proton will then report an ungated join ' +
        'instead of applying the role after the fact.',
    }),

  quarantineRoleId: snowflakeSchema.optional().register(protonFields, {
    field: 'role-id',
    label: 'Quarantine role',
    description:
      'Swapped in by /quarantine, which records every role it takes off so /unquarantine can put ' +
      'them back exactly. Isolating a member is only safe if undoing it is exact.',
  }),
});

export type VerificationConfig = z.infer<typeof verificationConfigSchema>;

export const verificationDefaultConfig: VerificationConfig = {
  enabled: false,
  applyUnverifiedOnJoin: true,
};

export const VERIFICATION_SCHEMA_VERSION = 1;
