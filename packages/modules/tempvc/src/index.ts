import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { tempVcCommands } from './commands.ts';
import {
  TEMPVC_SCHEMA_VERSION,
  tempVcConfigSchema,
  tempVcDefaultConfig,
  tempVcFormSchema,
} from './config.ts';
import type { TempVcDeps } from './deps.ts';
import { createTempVcListener } from './voice.ts';

export { tempVcCommands, vcCommand, withConnect } from './commands.ts';
export {
  CHANNEL_NAME_MAX,
  DEFAULT_NAME_TEMPLATE,
  HUBS_CEILING,
  hubFor,
  MODULE_ID,
  OWNER_PLACEHOLDER,
  renderChannelName,
  TEMPVC_SCHEMA_VERSION,
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
  type TempVcPlan,
  type TempVcStep,
  type TransitionFacts,
  type VoiceTransition,
} from './decide.ts';
export { bindStore, describeUnbound, type StoreBinding, type TempVcDeps } from './deps.ts';
export { reply } from './perform.ts';
export {
  RedisTempVcStore,
  type RedisTempVcStoreOptions,
  TEMPVC_PREFIX,
  TEMPVC_TTL_MS,
} from './redis-store.ts';
export type { TempChannel, TempVcStore } from './store.ts';
export {
  createTempVcListener,
  handleGuildAvailable,
  handleVoiceState,
  readChannelIds,
  readVoiceMember,
  readVoiceStates,
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

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],

    requiredPermissions: [
      Permissions.ViewChannel,
      Permissions.ManageChannels,
      Permissions.MoveMembers,
    ],
    actionKinds: [
      'interaction_reply',
      'create_channel',
      'edit_channel',
      'delete_channel',
      'move_member',
    ],

    configLimits: [{ key: 'tempVcHubs', path: 'hubs' }],

    commands: tempVcCommands(deps),
    listeners: [createTempVcListener(deps)],

    dashboard: {
      icon: 'voice',
      sections: [{ id: 'general', title: 'General', fields: ['enabled', 'ownerCommands'] }],
    },
  };
}

export const tempVcModule: ModuleManifest<typeof tempVcConfigSchema> = createTempVcModule();

export default tempVcModule;
