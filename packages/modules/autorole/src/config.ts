import { protonFields } from '@proton/core';
import { z } from 'zod';

export const AUTOROLE_SCHEMA_VERSION = 1;

export const MAX_STICKY_ROLES = 25;

const roleIdArray = z.array(
  z
    .string()
    .regex(/^\d{17,20}$/, 'must be a Discord role id')
    .register(protonFields, {
      field: 'role-id',
    }),
);

export const autoroleConfigSchema = z.object({
  enabled: z.boolean().default(false).register(protonFields, {
    label: 'Enabled',
    description: 'Grant roles on join, and give returning members their roles back.',
  }),

  autoroleIds: roleIdArray.max(10).default([]).register(protonFields, {
    label: 'Roles to grant on join',
    description: 'Every member who joins receives these. Leave empty to grant nothing.',
  }),

  stickyEnabled: z.boolean().default(false).register(protonFields, {
    label: 'Restore roles on rejoin',
    description:
      'Remember each member’s roles while they are here, and give them back if they return.',
  }),

  stickyRoleIds: roleIdArray.max(MAX_STICKY_ROLES).default([]).register(protonFields, {
    label: 'Roles eligible for restoring',
    description:
      'Only these roles come back on rejoin. Leave empty to restore every role the member had.',
  }),
});

export type AutoroleConfig = z.infer<typeof autoroleConfigSchema>;

export const autoroleDefaultConfig: AutoroleConfig = autoroleConfigSchema.parse({});
