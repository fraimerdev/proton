import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createSweepHandler, SWEEP_JOB_ID } from './cleanup.ts';
import { tempVcCommands } from './commands.ts';
import {
  liftStoredConfig,
  TEMPVC_SCHEMA_VERSION,
  tempVcConfigSchema,
  tempVcDefaultConfig,
  tempVcFormSchema,
} from './config.ts';
import type { TempVcDeps } from './deps.ts';
import { createTempVcInteractionListener } from './interactions.ts';
import { createTempVcListener } from './voice.ts';

export {
  armPatrol,
  armSweep,
  createSweepHandler,
  PATROL_INTERVAL_MS,
  PATROL_KEY,
  patrol,
  SWEEP_BATCH,
  SWEEP_JOB_ID,
  type SweepReport,
  sweep,
} from './cleanup.ts';
export { type Held, tempVcCommands, voiceCommand } from './commands.ts';
export {
  allows,
  blankHub,
  CATEGORY_CHANNEL_TYPE,
  CHANNEL_NAME_MAX,
  cooldownMsOf,
  DEFAULT_NAME_TEMPLATE,
  delayMsOf,
  HUBS_CEILING,
  hubById,
  hubFor,
  liftStoredConfig,
  MODULE_ID,
  NAME_PLACEHOLDERS,
  type NameFacts,
  type NamePlaceholder,
  OWNER_CONTROL_LABELS,
  OWNER_CONTROLS,
  OWNER_PLACEHOLDER,
  OWNERLESS_LABELS,
  OWNERLESS_MODES,
  type OwnerControl,
  type OwnerControls,
  type OwnerlessMode,
  ownerControlsSchema,
  PERMISSION_SYNC_LABELS,
  PERMISSION_SYNC_MODES,
  type PermissionSyncMode,
  PRIVACY_LABELS,
  PRIVACY_MODES,
  type PrivacyMode,
  renderChannelName,
  TEMP_ROLE_LABELS,
  TEMP_ROLE_MODES,
  TEMPVC_SCHEMA_VERSION,
  type TempRoleMode,
  type TempVcConfig,
  type TempVcHub,
  tempVcConfigSchema,
  tempVcDefaultConfig,
  tempVcFormSchema,
  tempVcHubSchema,
  tempVcHubsSchema,
  VOICE_CHANNEL_TYPE,
} from './config.ts';
export {
  planReconcile,
  planTransition,
  type ReconcileFacts,
  type ReconcilePlan,
  type ReconcileRow,
  type TempSide,
  type TempVcPlan,
  type TempVcStep,
  type TransitionFacts,
  type VoiceTransition,
} from './decide.ts';
export {
  type BoundService,
  bindService,
  describeUnbound,
  type ServiceBinding,
  type TempVcDeps,
} from './deps.ts';
export {
  createTempVcInteractionListener,
  handleComponent,
  handleModal,
  type Outcome,
  type Press,
  REGIONS,
  readPress,
  TEMPVC_INTERACTION_EVENT_TYPES,
} from './interactions.ts';
export {
  LIMIT_FIELD,
  limitModal,
  MODAL_ACTION,
  memberSelect,
  needsTarget,
  PANEL_ACTION,
  PANEL_LAYOUT,
  type PanelInput,
  type PanelMessage,
  PRIVACY_SELECT_ACTION,
  panelComponents,
  panelMessage,
  privacySelect,
  RENAME_FIELD,
  renameModal,
  USER_SELECT_ACTION,
} from './interface.ts';
export {
  type LogFields,
  logTempVoice,
  renderLogLine,
  TEMP_VOICE_EVENTS,
  type TempVoiceEvent,
} from './log.ts';
export { reply } from './perform.ts';
export {
  type AccessEntry,
  canJoin,
  MEMBER_OVERWRITE,
  type OverwritePlanInput,
  planOverwrites,
  privacyOf,
  ROLE_OVERWRITE,
} from './permissions.ts';
export {
  RedisCooldownGate,
  RedisPresenceStore,
  type RedisPresenceStoreOptions,
  TEMPVC_PREFIX,
  TEMPVC_TTL_MS,
} from './redis-store.ts';
export {
  type Db,
  DrizzleTempVoiceRepository,
  type Reservation,
  type ReserveInput,
  type TempVoiceRepository,
} from './repository.ts';
export {
  type CooldownGate,
  type CreateOutcome,
  type Occupancy,
  type ServiceDeps,
  TemporaryVoiceService,
} from './service.ts';
export type { PresenceStore } from './store.ts';
export {
  ACCESS_KINDS,
  type AccessKind,
  TEMP_VOICE_STATUSES,
  type TempVoiceChannelRow,
  type TempVoiceStatus,
  tempVoiceAccess,
  tempVoiceChannels,
  tempVoiceRoles,
} from './table.ts';
export {
  createTempVcListener,
  handleChannelDeleted,
  handleGuildAvailable,
  handleVoiceState,
  type Presence,
  presenceOf,
  readChannelIds,
  readVoiceMember,
  readVoiceStates,
  STALE_RESERVATION_MS,
  TEMPVC_EVENT_TYPES,
  type VoiceMember,
} from './voice.ts';

export function createTempVcModule(
  deps: TempVcDeps = {},
): ModuleManifest<typeof tempVcConfigSchema> {
  return {
    id: 'tempvc',
    name: 'Temporary Voice Channels',
    category: 'utility',
    configSchema: tempVcConfigSchema,
    formSchema: tempVcFormSchema,
    defaultConfig: tempVcDefaultConfig,
    schemaVersion: TEMPVC_SCHEMA_VERSION,
    liftStoredConfig,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],

    // Connect is not decoration: REQUIRED_PERMISSIONS['move_member'] is MoveMembers | Connect, and
    // leaving it out here let evaluate() report the module healthy in a guild where every move was
    // about to be refused, naming nothing for the admin to fix. ManageRoles is what rewrites a
    // channel's overwrites, which is how privacy, trust and block are enforced.
    requiredPermissions: [
      Permissions.ViewChannel,
      Permissions.ManageChannels,
      Permissions.MoveMembers,
      Permissions.Connect,
      Permissions.ManageRoles,
    ],
    actionKinds: [
      'interaction_reply',
      'interaction_followup',
      'send',
      'create_channel',
      'edit_channel',
      'delete_channel',
      'move_member',
      'add_role',
      'remove_role',
    ],

    configLimits: [{ key: 'tempVcHubs', path: 'hubs' }],

    commands: tempVcCommands(deps),
    listeners: [createTempVcListener(deps), createTempVcInteractionListener(deps)],

    schedules: [SWEEP_JOB_ID],
    scheduledHandlers: { [SWEEP_JOB_ID]: createSweepHandler(deps) },

    dashboard: {
      icon: 'voice',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'ownerCommands'] },
        { id: 'protection', title: 'Protection', fields: ['serverCreationLimit'] },
        { id: 'logging', title: 'Logging', fields: ['loggingEnabled', 'logChannelId'] },
      ],
    },
  };
}

export const tempVcModule: ModuleManifest<typeof tempVcConfigSchema> = createTempVcModule();

export default tempVcModule;
