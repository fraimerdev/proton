import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  JOINROLES_SCHEMA_VERSION,
  joinrolesConfigSchema,
  joinrolesDefaultConfig,
} from './config.ts';
import { createJoinRolesListener, type JoinRolesDeps } from './listeners.ts';
import { createAutosyncHandler, JOINROLES_AUTOSYNC_JOB } from './sync/autosync.ts';
import { createJoinRolesSyncListener } from './sync/listener.ts';
import { createSyncBatchHandler, JOINROLES_SYNC_JOB } from './sync/run.ts';

export {
  JOINROLES_SCHEMA_VERSION,
  type JoinrolesConfig,
  joinrolesConfigSchema,
  joinrolesDefaultConfig,
  MAX_BOT_ROLES,
  MAX_MEMBER_ROLES,
  MAX_STICKY_ROLES,
  MAX_SYNC_EXCLUDE_ROLES,
  SYNC_INTERVALS,
  type SyncInterval,
} from './config.ts';
export { DrizzleStickyRoleStore } from './drizzle-store.ts';
export {
  type GrantableRoles,
  type GrantPlan,
  type GrantRefusal,
  grantableRoles,
  planGrant,
} from './grant.ts';
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
export {
  AUTOSYNC_BUSY_RETRY_MS,
  AUTOSYNC_OVERDUE_MS,
  autosyncRunId,
  createAutosyncHandler,
  JOINROLES_AUTOSYNC_JOB,
  JOINROLES_AUTOSYNC_KEY,
  SYNC_INTERVAL_MS,
} from './sync/autosync.ts';
export { createJoinRolesSyncListener, JOINROLES_SYNC_EVENT_TYPES } from './sync/listener.ts';
export {
  type MemberPlan,
  planMember,
  type SyncPlanInput,
  syncPlanInput,
} from './sync/plan.ts';
export { preflightSync, type SyncPreflight } from './sync/preflight.ts';
export {
  createSyncBatchHandler,
  JOINROLES_SYNC_JOB,
  SYNC_ATTEMPTS,
  SYNC_COUNT_PAGES_PER_TICK,
  SYNC_FAILURES,
  SYNC_GRANTS_PER_TICK,
  SYNC_PAGE,
  SYNC_TICK_BUDGET_MS,
  type SyncBatchData,
  syncBatchKey,
  syncGrantKey,
} from './sync/run.ts';
export { type StartOutcome, startRun } from './sync/start.ts';
export {
  claimRun,
  JOINROLES_SYNC_PREFIX,
  type JoinRolesRunStore,
  RedisJoinRolesRunStore,
  type SyncClaim,
} from './sync/store.ts';

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
    actionKinds: ['add_role'],

    listeners: [createJoinRolesListener(deps), createJoinRolesSyncListener(deps)],

    schedules: [JOINROLES_SYNC_JOB, JOINROLES_AUTOSYNC_JOB],
    scheduledHandlers: {
      [JOINROLES_SYNC_JOB]: createSyncBatchHandler(deps),
      [JOINROLES_AUTOSYNC_JOB]: createAutosyncHandler(deps),
    },

    dashboard: {
      icon: 'user-plus',
      sections: [
        {
          id: 'grant',
          title: 'Roles on join',
          fields: ['enabled', 'memberRoleIds', 'botRoleIds', 'grantWhenScreeningPasses'],
        },
        { id: 'sticky', title: 'Sticky roles', fields: ['stickyEnabled', 'stickyRoleIds'] },
        {
          id: 'sync',
          title: 'Sync',
          fields: [
            'syncExcludeEnabled',
            'syncExcludeRoleIds',
            'syncScheduleEnabled',
            'syncInterval',
          ],
        },
      ],
    },
  };
}

export const joinrolesModule: ModuleManifest<typeof joinrolesConfigSchema> =
  createJoinRolesModule();

export default joinrolesModule;
