import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { AUTOROLE_SCHEMA_VERSION, autoroleConfigSchema, autoroleDefaultConfig } from './config.ts';
import { type AutoroleDeps, createStickyListener } from './listeners.ts';
import { autorolePresetRules } from './rules.ts';

export {
  AUTOROLE_SCHEMA_VERSION,
  type AutoroleConfig,
  autoroleConfigSchema,
  autoroleDefaultConfig,
  MAX_STICKY_ROLES,
} from './config.ts';
export { DrizzleStickyRoleStore } from './drizzle-store.ts';
export {
  AUTOROLE_ACTOR,
  AUTOROLE_EVENT_TYPES,
  AUTOROLE_MODULE_ID,
  type AutoroleDeps,
  createStickyListener,
} from './listeners.ts';
export { planRestore, type RestorePlan } from './restore.ts';
export { autorolePresetRules, autoroleRuleId, autoroleRules } from './rules.ts';
export type { StickyRoleStore } from './store.ts';

export function createAutoroleModule(
  deps: AutoroleDeps = {},
): ModuleManifest<typeof autoroleConfigSchema> {
  return {
    id: 'autorole',
    name: 'Autorole & sticky roles',
    category: 'utility',
    configSchema: autoroleConfigSchema,
    defaultConfig: autoroleDefaultConfig,
    schemaVersion: AUTOROLE_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],

    requiredPermissions: [Permissions.ManageRoles],

    listeners: [createStickyListener(deps)],
    rules: autorolePresetRules,
    migrations: [],

    dashboard: {
      icon: 'user-plus',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        { id: 'autorole', title: 'Roles on join', fields: ['autoroleIds'] },
        { id: 'sticky', title: 'Sticky roles', fields: ['stickyEnabled', 'stickyRoleIds'] },
      ],
    },
  };
}

export const autoroleModule: ModuleManifest<typeof autoroleConfigSchema> = createAutoroleModule();

export default autoroleModule;
