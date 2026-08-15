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

export const pingModule: ModuleManifest<typeof pingConfigSchema> = {
  id: 'ping',
  name: 'Ping',
  category: 'utility',
  configSchema: pingConfigSchema,
  defaultConfig: pingDefaultConfig,
  schemaVersion: PING_SCHEMA_VERSION,

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
