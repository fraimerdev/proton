import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { countersCommands } from './commands.ts';
import {
  COUNTERS_SCHEMA_VERSION,
  countersConfigSchema,
  countersDefaultConfig,
  countersFormSchema,
} from './config.ts';
import type { CountersDeps } from './deps.ts';
import { createCountersListener } from './listener.ts';
import { createRefreshHandler, REFRESH_JOB } from './refresh.ts';

export { countersCommand, countersCommands } from './commands.ts';
export {
  CHANNEL_NAME_MAX,
  COUNT_PLACEHOLDER,
  COUNTER_ID_MAX,
  COUNTER_SOURCES,
  COUNTERS_CEILING,
  COUNTERS_SCHEMA_VERSION,
  type Counter,
  type CounterSource,
  type CountersConfig,
  counterSchema,
  countersConfigSchema,
  countersDefaultConfig,
  countersFormSchema,
  countersListSchema,
  MODULE_ID,
  REFRESH_INTERVAL_MS,
  TEMPLATE_MAX,
} from './config.ts';
export {
  type CreateOutcome,
  createCounterChannel,
  LOST_CREATE,
  NO_CHANNEL_ID,
  VOICE_CHANNEL_TYPE,
} from './create.ts';
export {
  bindGuildState,
  type CountersDeps,
  describeUnbound,
  type GuildStateBinding,
} from './deps.ts';
export {
  COUNTERS_EVENT_TYPES,
  createCountersListener,
  reconcileSchedule,
  type ScheduleOutcomeName,
} from './listener.ts';
export { NO_STATE, NO_STORE, NOT_WIRED, renameChannel, reply } from './perform.ts';
export {
  createRefreshHandler,
  REFRESH_JOB,
  REFRESH_KEY,
  type RefreshResult,
  refreshCounters,
  refreshKeyRoot,
} from './refresh.ts';
export {
  type CounterCreation,
  type CounterEdit,
  type CounterFailure,
  type CounterPlan,
  type CreationFailure,
  countFor,
  NO_COUNTERS,
  plan,
  type RefreshOutcome,
  renderName,
  renderReport,
} from './render.ts';
export {
  type CounterChannelStore,
  DrizzleCounterChannelStore,
  type OwnedChannel,
} from './store.ts';
export { type CounterChannelRow, counterChannels } from './table.ts';

export function createCountersModule(
  deps: CountersDeps = {},
): ModuleManifest<typeof countersConfigSchema> {
  return {
    id: 'counters',
    name: 'Counter channels',
    category: 'utility',
    configSchema: countersConfigSchema,
    formSchema: countersFormSchema,
    defaultConfig: countersDefaultConfig,
    schemaVersion: COUNTERS_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds],

    // Manage Roles is deliberately absent: it is needed only to deny Connect on a channel Proton
    // makes, and requiring it here would switch the whole module off for a server that only
    // renames channels it was pointed at.
    requiredPermissions: [Permissions.ViewChannel, Permissions.ManageChannels],
    actionKinds: ['interaction_reply', 'edit_channel', 'create_channel', 'set_channel_overwrite'],

    configLimits: [{ key: 'counters', path: 'counters' }],

    commands: countersCommands(deps),
    listeners: [createCountersListener()],

    schedules: [REFRESH_JOB],
    scheduledHandlers: { [REFRESH_JOB]: createRefreshHandler(deps) },

    dashboard: {
      icon: 'hash',
      sections: [{ id: 'general', title: 'General', fields: ['enabled'] }],
    },
  };
}

export const countersModule: ModuleManifest<typeof countersConfigSchema> = createCountersModule();

export default countersModule;
