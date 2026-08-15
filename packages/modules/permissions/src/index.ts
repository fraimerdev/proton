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

/**
 * Per-guild command permission overrides (PLAN.md §8, Phase 1).
 *
 * A module with no commands and no listeners, which is the point: what it ships
 * is a per-guild policy plus `evaluateCommandGate`, and the runtime consults
 * both before dispatching *any* module's command. Enforcement cannot live in a
 * handler here — it has to gate other modules' commands, and I3 forbids a module
 * reaching into another. So the decision is data and a pure function; the
 * dispatch point owns applying it.
 *
 * A guild layers these on top of Discord's native command permissions rather
 * than replacing them: Discord still hides a command from members who lack its
 * `default_member_permissions`, and this narrows what remains.
 */
export const permissionsModule: ModuleManifest<typeof permissionsConfigSchema> = {
  id: PERMISSIONS_MODULE_ID,
  name: 'Permissions',
  category: 'utility',
  configSchema: permissionsConfigSchema,
  defaultConfig: permissionsDefaultConfig,
  schemaVersion: PERMISSIONS_SCHEMA_VERSION,
  // Interactions need no privileged intent, and nothing here watches members.
  requiredIntents: [GatewayIntentBits.Guilds],
  /**
   * Only ViewChannel, and even that is a floor rather than a need: refusing a
   * command is an interaction callback, which Discord always permits an app to
   * make (`REQUIRED_PERMISSIONS.interaction_reply` is `0n`). Declaring more
   * would let a missing permission disable the module — and a permission system
   * that switches itself off is worse than one that was never installed.
   */
  requiredPermissions: [Permissions.ViewChannel],
  migrations: [],
  dashboard: {
    icon: 'lock',
    sections: [
      { id: 'general', title: 'General', fields: ['enabled'] },
      {
        // `overrides` is claimed so the section owns it, but no generated
        // descriptor will ever appear for it — the map's keys are the loaded
        // commands, not a static shape (§9). The dashboard renders this section
        // from `commandOverridesFormSchema(registry command names)`.
        id: 'overrides',
        title: 'Command overrides',
        fields: ['overrides'],
      },
    ],
  },
};

export default permissionsModule;
