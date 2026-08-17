import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  JOINROLES_SCHEMA_VERSION,
  joinrolesConfigSchema,
  joinrolesDefaultConfig,
} from './config.ts';
import { createJoinRolesListener, type JoinRolesDeps } from './listeners.ts';

export {
  JOINROLES_SCHEMA_VERSION,
  type JoinrolesConfig,
  joinrolesConfigSchema,
  joinrolesDefaultConfig,
  MAX_BOT_ROLES,
  MAX_MEMBER_ROLES,
  MAX_STICKY_ROLES,
} from './config.ts';
export { DrizzleStickyRoleStore } from './drizzle-store.ts';
export { type GrantPlan, planGrant } from './grant.ts';
export {
  createJoinRolesListener,
  JOINROLES_ACTOR,
  JOINROLES_EVENT_TYPES,
  JOINROLES_MODULE_ID,
  type JoinRolesDeps,
  joinrolesKey,
  type MemberFacts,
  readMember,
} from './listeners.ts';
export {
  PENDING_PREFIX,
  PENDING_TTL_MS,
  type PendingGrantStore,
  RedisPendingGrantStore,
} from './pending.ts';
export { planRestore, type RestorePlan } from './restore.ts';
export type { StickyRoleStore } from './store.ts';

export function createJoinRolesModule(
  deps: JoinRolesDeps = {},
): ModuleManifest<typeof joinrolesConfigSchema> {
  return {
    id: 'joinroles',
    name: 'Join Roles',
    category: 'utility',
    configSchema: joinrolesConfigSchema,
    defaultConfig: joinrolesDefaultConfig,
    schemaVersion: JOINROLES_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    requiredPermissions: [Permissions.ManageRoles],

    listeners: [createJoinRolesListener(deps)],

    dashboard: {
      icon: 'user-plus',
      sections: [
        {
          id: 'grant',
          title: 'Roles on join',
          fields: ['enabled', 'memberRoleIds', 'botRoleIds', 'grantWhenScreeningPasses'],
        },
        { id: 'sticky', title: 'Sticky roles', fields: ['stickyEnabled', 'stickyRoleIds'] },
      ],
    },
  };
}

export const joinrolesModule: ModuleManifest<typeof joinrolesConfigSchema> =
  createJoinRolesModule();

export default joinrolesModule;
