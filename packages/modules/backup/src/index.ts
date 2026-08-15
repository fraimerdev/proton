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

/**
 * Backup and restore (PLAN.md §8 phase 2), obfuscation-aware from day one.
 *
 * §10.1 is the whole design brief. From 16 Nov 2026 a channel the bot cannot
 * VIEW_CHANNEL still arrives over the gateway, but with its name and topic
 * replaced by `___hidden___` and the `CHANNEL_OBFUSCATED` flag set — and
 * `GET /guilds/{id}/channels` omits it altogether. Two consequences run through
 * every file here:
 *
 *  1. A snapshot **marks** what it could not capture and says so to an admin at
 *     backup time, not at restore time. A backup that quietly omits channels is
 *     worse than no backup, because it is trusted: the server finds out during
 *     the restore, which is to say after the nuke.
 *  2. A restore **skips** those channels with a per-channel reason rather than
 *     recreating them from a placeholder. A nameless, permissionless channel
 *     standing where a private one used to be looks restored and is not.
 *
 * Detection is by flag, never by name: `isObfuscatedChannel` is imported from
 * the gateway's normaliser rather than reimplemented, so the bit has exactly one
 * definition. A guild may legitimately name a real channel `___hidden___`, and
 * matching the string would hide a channel Proton can actually see.
 *
 * A factory rather than a constant for the reason `createLoggingModule` is one:
 * §7's `ModuleContext` has no storage port and no view of the guild's structure.
 *
 * Known blockers, all in the framework and all outside a module's remit. What is
 * declared here is correct and tested; what it cannot do today is act:
 *
 *  1. **Restore cannot be applied.** `ACTION_KINDS` has no `create_channel`,
 *     `create_role` or `set_overwrites`, and I1/I2 forbid a module from calling
 *     Discord around the executor. So `/backup restore` computes the full plan,
 *     reports it, and changes nothing. Closing this needs three action kinds,
 *     their payload schemas, their REST mappings and their prechecks in
 *     `packages/core` — plus the old-id → new-id remapping described on
 *     `RestoreOp`, which only the applier can do because only it learns the new
 *     ids. That is framework work, deliberately not done from inside a module.
 *  2. `ModuleContext` has no storage port, hence `BackupDeps.store`.
 *  3. Nothing in the framework holds the guild's *full* channel and role list.
 *     `GuildStateStore` keeps ids, parents and overwrites — everything I8 needs
 *     and nothing a restore needs — so `readLayout` is bound by the host.
 *     `apps/worker/src/guild-layout.ts` now does exactly that, keeping the raw
 *     GUILD_CREATE channel and role objects verbatim so the `CHANNEL_OBFUSCATED`
 *     flag survives. Widening `ChannelState` for one module's benefit would have
 *     been the wrong fix.
 *  4. **A layout is only as fresh as the last GUILD_CREATE.** The normaliser
 *     emits nothing for CHANNEL_CREATE/UPDATE/DELETE or GUILD_ROLE_*, and the
 *     audit-derived `channel.created`/`role.deleted` events carry ids and an
 *     actor rather than the objects. The gateway receives GUILD_CREATE on every
 *     (re)connect, so the window is small — but a channel created since then is
 *     absent from a snapshot taken now.
 *  5. There are no scheduled backups: `jobs` is left empty and every snapshot is
 *     one an admin asked for. A runner now exists
 *     (`apps/worker/src/module-jobs.ts`), so adding a schedule is a decision
 *     about retention and cost rather than a missing mechanism.
 */
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

    /**
     * GUILDS carries GUILD_CREATE and every channel and role update — the
     * dispatches the guild layout is built from. Not privileged.
     */
    requiredIntents: [GatewayIntentBits.Guilds],

    /**
     * VIEW_CHANNEL, and only VIEW_CHANNEL.
     *
     * It is the permission the whole module turns on: without it every channel
     * is obfuscated, so a "backup" would be a list of ids with no names, no
     * topics and no permissions. Disabling the module outright with that named
     * is far better than handing a guild an empty snapshot it believes in.
     *
     * MANAGE_CHANNELS and MANAGE_ROLES are deliberately absent even though a
     * restore will need both. `requiredPermissions` is a hard gate, and gating
     * on them would leave a server that only wants snapshots with no backups at
     * all — the strictly worse trade. The restore report names them instead, at
     * the point where they matter.
     */
    requiredPermissions: [Permissions.ViewChannel],

    commands: createBackupCommands(deps),

    /**
     * `backups` is a core table (§6), already created by
     * `packages/db/drizzle`. Repeating its DDL here would be two copies with no
     * mechanism to keep them equal.
     */
    migrations: [],

    dashboard: {
      icon: 'archive',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        { id: 'retention', title: 'Retention', fields: ['retainBackups'] },
      ],
    },
  };
}

/**
 * The manifest with nothing bound — what the dashboard and the API render.
 *
 * Every command answers with `describeUnbound`, naming the ports and the exact
 * construction, so an unwired deployment reports that it cannot back the server
 * up instead of appearing to have done so.
 */
export const backupModule: ModuleManifest<typeof backupConfigSchema> = createBackupModule();

export default backupModule;
