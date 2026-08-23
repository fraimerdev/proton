import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createBackupCommands } from './commands.ts';
import { BACKUP_SCHEMA_VERSION, backupConfigSchema, backupDefaultConfig } from './config.ts';
import type { BackupDeps } from './deps.ts';

export { createBackupCommands, MODULE_ID } from './commands.ts';
export {
  BACKUP_SCHEMA_VERSION,
  type BackupConfig,
  backupConfigSchema,
  backupDefaultConfig,
  MAX_RETAINED_BACKUPS,
} from './config.ts';
export {
  type BackupDeps,
  type BindResult,
  type BoundBackupDeps,
  bindDeps,
  describeUnbound,
} from './deps.ts';
export { DrizzleBackupStore } from './postgres-store.ts';
export {
  describeRestore,
  isRestoreRefusal,
  planRestore,
  RESTORE_SKIP_CODES,
  type RestoreInput,
  type RestoreOp,
  type RestorePlan,
  type RestoreRefusal,
  type RestoreResult,
  type RestoreSkip,
  type RestoreSkipCode,
  restoreIsDryRun,
  summariseRestore,
} from './restore.ts';
export {
  buildSnapshot,
  type CaptureReport,
  type CaptureResult,
  CHANNEL_TYPE_CATEGORY,
  type ChannelSnapshot,
  captureChannel,
  channelSnapshotSchema,
  coverageOf,
  describeCapture,
  type GuildLayout,
  type GuildSnapshot,
  guildSnapshotSchema,
  LAYOUT_SOURCES,
  type LayoutSource,
  type OverwriteSnapshot,
  overwriteSnapshotSchema,
  type RoleSnapshot,
  roleSnapshotSchema,
  SNAPSHOT_VERSION,
} from './snapshot.ts';
export {
  type BackupRecord,
  type BackupStore,
  CorruptSnapshotError,
} from './store.ts';

export function createBackupModule(
  deps: BackupDeps = {},
): ModuleManifest<typeof backupConfigSchema> {
  return {
    id: 'backup',
    name: 'Backup',
    category: 'security',
    configSchema: backupConfigSchema,
    defaultConfig: backupDefaultConfig,
    schemaVersion: BACKUP_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds],

    requiredPermissions: [Permissions.ViewChannel],
    actionKinds: ['create_role', 'create_channel', 'interaction_reply'],

    commands: createBackupCommands(deps),

    dashboard: {
      icon: 'archive',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        { id: 'retention', title: 'Retention', fields: ['retainBackups'] },
      ],
    },
  };
}

export const backupModule: ModuleManifest<typeof backupConfigSchema> = createBackupModule();

export default backupModule;
