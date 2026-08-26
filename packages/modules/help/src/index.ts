import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { helpCommand } from './command.ts';
import { HELP_SCHEMA_VERSION, helpConfigSchema, helpDefaultConfig, MODULE_ID } from './config.ts';
import type { HelpDeps } from './deps.ts';

export { HELP_DESCRIPTION, helpCommand } from './command.ts';
export {
  HELP_SCHEMA_VERSION,
  type HelpConfig,
  helpConfigSchema,
  helpDefaultConfig,
  MODULE_ID,
} from './config.ts';
export { dashboardLink, type HelpDeps, NO_DASHBOARD_URL } from './deps.ts';
export { buildHelpComponents, HELP_COLOUR, OPEN_DASHBOARD } from './overview.ts';

export function createHelpModule(deps: HelpDeps = {}): ModuleManifest<typeof helpConfigSchema> {
  return {
    id: MODULE_ID,
    name: 'Help',
    category: 'utility',
    configSchema: helpConfigSchema,
    defaultConfig: helpDefaultConfig,
    schemaVersion: HELP_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds],

    requiredPermissions: [Permissions.ViewChannel],
    actionKinds: ['interaction_reply'],
    commands: [helpCommand(deps)],

    dashboard: {
      icon: 'help-circle',
      sections: [{ id: 'general', title: 'General', fields: ['enabled', 'ephemeral'] }],
    },
  };
}

export const helpModule: ModuleManifest<typeof helpConfigSchema> = createHelpModule();

export default helpModule;
