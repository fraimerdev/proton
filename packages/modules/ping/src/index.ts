import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { pingCommand } from './command.ts';
import { PING_SCHEMA_VERSION, pingConfigSchema, pingDefaultConfig } from './config.ts';

export { pingCommand } from './command.ts';
export {
  PING_SCHEMA_VERSION,
  type PingConfig,
  pingConfigSchema,
  pingDefaultConfig,
} from './config.ts';

/**
 * The Gate 0 proof module (PLAN.md §8).
 *
 * Everything here is declaration. Ping contains no framework code, no
 * registration boilerplate and no permission handling of its own — if adding a
 * second module needs more than a file like this, the framework has failed its
 * own acceptance criterion.
 */
export const pingModule: ModuleManifest<typeof pingConfigSchema> = {
  id: 'ping',
  name: 'Ping',
  category: 'utility',
  configSchema: pingConfigSchema,
  defaultConfig: pingDefaultConfig,
  schemaVersion: PING_SCHEMA_VERSION,
  // Non-privileged: /ping works even with no privileged intents granted.
  requiredIntents: [GatewayIntentBits.Guilds],
  requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
  commands: [pingCommand],
  migrations: [],
  dashboard: {
    icon: 'activity',
    sections: [{ id: 'general', title: 'General', fields: [] }],
  },
};

export default pingModule;
