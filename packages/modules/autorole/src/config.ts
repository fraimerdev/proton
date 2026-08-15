import { protonFields } from '@proton/core';
import { z } from 'zod';

/** Bumped whenever the shape below changes (I5). */
export const AUTOROLE_SCHEMA_VERSION = 1;

/**
 * How many roles a member may have restored to them.
 *
 * Not a Discord limit — Discord's own cap is 250 roles per member — but a bound
 * on the blast radius of a bug. Sticky roles is the one feature that hands
 * permissions back automatically, so a snapshot that somehow grew wrong should
 * fail loudly at a readable number rather than issuing 250 role grants.
 */
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

  /**
   * Roles every new member receives.
   *
   * These compile to preset rules rather than being applied by a listener in
   * this module — see `rules.ts` for why that distinction matters.
   */
  autoroleIds: roleIdArray.max(10).default([]).register(protonFields, {
    label: 'Roles to grant on join',
    description: 'Every member who joins receives these. Leave empty to grant nothing.',
  }),

  stickyEnabled: z.boolean().default(false).register(protonFields, {
    label: 'Restore roles on rejoin',
    description:
      'Remember each member’s roles while they are here, and give them back if they return.',
  }),

  /**
   * Which roles are eligible to be restored. Empty means "all of them".
   *
   * An allowlist rather than a blocklist because the failure modes are not
   * symmetric: forgetting to add a role to an allowlist means it is not handed
   * back, which is a support ticket. Forgetting to add a moderator role to a
   * blocklist means Proton silently re-promotes someone the guild demoted by
   * kicking them, which is a security incident.
   */
  stickyRoleIds: roleIdArray.max(MAX_STICKY_ROLES).default([]).register(protonFields, {
    label: 'Roles eligible for restoring',
    description:
      'Only these roles come back on rejoin. Leave empty to restore every role the member had.',
  }),
});

export type AutoroleConfig = z.infer<typeof autoroleConfigSchema>;

export const autoroleDefaultConfig: AutoroleConfig = autoroleConfigSchema.parse({});
