import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  PERMISSIONS_SCHEMA_VERSION,
  permissionsConfigSchema,
  permissionsDefaultConfig,
} from './config.ts';
import { PERMISSIONS_MODULE_ID } from './gate.ts';

export {
  type CommandOverrides,
  commandOverridesFormSchema,
  commandOverridesSchema,
  PERMISSIONS_SCHEMA_VERSION,
  type PermissionsConfig,
  permissionsConfigSchema,
  permissionsDefaultConfig,
} from './config.ts';
export {
  type CommandGateDecision,
  type CommandGateInput,
  type CommandRefusal,
  evaluateCommandGate,
  MAX_LISTED_ROLES,
  PERMISSIONS_MODULE_ID,
  requiredRolesFor,
} from './gate.ts';

export const permissionsModule: ModuleManifest<typeof permissionsConfigSchema> = {
  id: PERMISSIONS_MODULE_ID,
  name: 'Permissions',
  category: 'utility',
  configSchema: permissionsConfigSchema,
  defaultConfig: permissionsDefaultConfig,
  schemaVersion: PERMISSIONS_SCHEMA_VERSION,

  requiredIntents: [GatewayIntentBits.Guilds],

  requiredPermissions: [Permissions.ViewChannel],
  migrations: [],
  dashboard: {
    icon: 'lock',
    sections: [
      { id: 'general', title: 'General', fields: ['enabled'] },
      {
        id: 'overrides',
        title: 'Command overrides',
        fields: ['overrides'],
      },
    ],
  },
};

export default permissionsModule;
