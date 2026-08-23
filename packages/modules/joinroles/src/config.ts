import { protonFields } from '@proton/core';
import { z } from 'zod';

export const JOINROLES_SCHEMA_VERSION = 2;

export const MAX_MEMBER_ROLES = 10;
export const MAX_BOT_ROLES = 10;
export const MAX_STICKY_ROLES = 25;

// A fresh schema per field: `.register()` mutates the instance it is called on, so registering
// field metadata on a shared snowflake schema would tag it as a role picker everywhere.
const roleIdArray = () =>
  z.array(
    z
      .string()
      .regex(/^\d{17,20}$/, 'must be a Discord role id')
      .register(protonFields, {
        field: 'role-id',
      }),
  );

export const joinrolesConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Grant roles on join',
  }),

  memberRoleIds: roleIdArray().max(MAX_MEMBER_ROLES).default([]).register(protonFields, {
    label: 'Roles for people',
  }),

  botRoleIds: roleIdArray().max(MAX_BOT_ROLES).default([]).register(protonFields, {
    label: 'Roles for bots',
  }),

  grantWhenScreeningPasses: z.boolean().default(true).register(protonFields, {
    label: 'Wait for Membership Screening',
  }),

  stickyEnabled: z.boolean().default(false).register(protonFields, {
    label: 'Restore roles on rejoin',
  }),

  stickyRoleIds: roleIdArray().max(MAX_STICKY_ROLES).default([]).register(protonFields, {
    label: 'Roles eligible for restoring',
    description: 'Empty restores every role the member had',
  }),
});

export type JoinrolesConfig = z.infer<typeof joinrolesConfigSchema>;

export const joinrolesDefaultConfig: JoinrolesConfig = joinrolesConfigSchema.parse({});
