import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createAntinukeCommands } from './commands.ts';
import { ANTINUKE_SCHEMA_VERSION, antinukeConfigSchema, antinukeDefaultConfig } from './config.ts';
import type { AntinukeDeps } from './deps.ts';
import { createAntinukeListener } from './listeners.ts';

export {
  ANTINUKE_ACTOR,
  type BreakerInput,
  type BreakerReport,
  MODULE_ID,
  tripBreaker,
} from './breaker.ts';
export {
  CLASS_LABELS,
  CLASS_OF_EVENT,
  classOfEvent,
  NUKE_CLASSES,
  type NukeClass,
  type Threshold,
  thresholdFor,
  WATCHED_EVENT_TYPES,
  type WatchedEventType,
} from './classes.ts';
export { createAntinukeCommands } from './commands.ts';
export {
  AFTER_STRIP_ACTIONS,
  type AfterStripAction,
  ANTINUKE_SCHEMA_VERSION,
  type AntinukeConfig,
  antinukeConfigSchema,
  antinukeDefaultConfig,
} from './config.ts';
export {
  type AntinukeDeps,
  type BindResult,
  type BoundAntinukeDeps,
  bindDeps,
  describeUnbound,
} from './deps.ts';
export {
  type AntinukeOutcome,
  announceLapse,
  createAntinukeListener,
  handleDestructiveEvent,
} from './listeners.ts';
export {
  hasLapsed,
  isCoveredByMaintenance,
  isMaintenanceRefusal,
  MAINTENANCE_GRACE_MS,
  MAINTENANCE_PREFIX,
  type MaintenancePlanInput,
  type MaintenanceRefusal,
  type MaintenanceStore,
  type MaintenanceWindow,
  maintenanceKey,
  maintenanceWindowSchema,
  planMaintenance,
  RedisMaintenanceStore,
} from './maintenance.ts';

export function createAntinukeModule(
  deps: AntinukeDeps = {},
): ModuleManifest<typeof antinukeConfigSchema> {
  return {
    id: 'antinuke',
    name: 'Anti-nuke',
    category: 'security',
    configSchema: antinukeConfigSchema,
    defaultConfig: antinukeDefaultConfig,
    schemaVersion: ANTINUKE_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildModeration],

    requiredPermissions: [Permissions.ViewAuditLog, Permissions.ManageRoles],

    commands: createAntinukeCommands(deps),
    listeners: [createAntinukeListener(deps)],

    dashboard: {
      icon: 'shield-alert',
      sections: [
        {
          id: 'general',
          title: 'General',
          fields: ['enabled', 'afterStrip', 'alertChannelId'],
        },
        {
          id: 'thresholds',
          title: 'Thresholds',
          fields: [
            'channelDeleteLimit',
            'channelDeleteWindow',
            'roleDeleteLimit',
            'roleDeleteWindow',
            'webhookDeleteLimit',
            'webhookDeleteWindow',
            'emojiDeleteLimit',
            'emojiDeleteWindow',
            'memberRemoveLimit',
            'memberRemoveWindow',
          ],
        },
        {
          id: 'maintenance',
          title: 'Maintenance mode',
          fields: ['maintenanceMaxDuration'],
        },
      ],
    },
  };
}

export const antinukeModule: ModuleManifest<typeof antinukeConfigSchema> = createAntinukeModule();

export default antinukeModule;
