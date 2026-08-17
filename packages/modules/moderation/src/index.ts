import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { channelCommands } from './commands/channel.ts';
import { memberCommands } from './commands/member.ts';
import {
  MODERATION_SCHEMA_VERSION,
  moderationConfigSchema,
  moderationDefaultConfig,
} from './config.ts';

export {
  channelCommands,
  lockdownCommand,
  slowmodeCommand,
  unlockCommand,
} from './commands/channel.ts';
export {
  banCommand,
  kickCommand,
  memberCommands,
  timeoutCommand,
  unbanCommand,
  untimeoutCommand,
  warnCommand,
} from './commands/member.ts';
export {
  MODERATION_SCHEMA_VERSION,
  type ModerationConfig,
  moderationConfigSchema,
  moderationDefaultConfig,
} from './config.ts';
export { MODULE_ID } from './perform.ts';

export const moderationModule: ModuleManifest<typeof moderationConfigSchema> = {
  id: 'moderation',
  name: 'Moderation',
  category: 'moderation',
  configSchema: moderationConfigSchema,
  defaultConfig: moderationDefaultConfig,
  schemaVersion: MODERATION_SCHEMA_VERSION,

  requiredIntents: [GatewayIntentBits.Guilds],

  requiredPermissions: [
    Permissions.ViewChannel,
    Permissions.BanMembers,
    Permissions.KickMembers,
    Permissions.ModerateMembers,
    Permissions.ManageChannels,

    Permissions.ManageRoles,
  ],
  commands: [...memberCommands, ...channelCommands],

  emits: ['moderation.warned'],
  dashboard: {
    icon: 'shield',
    sections: [
      { id: 'general', title: 'General', fields: ['enabled', 'publicReplies'] },
      {
        id: 'policy',
        title: 'Policy',
        fields: ['requireReason', 'defaultTimeoutDuration', 'defaultBanDeleteDays'],
      },
    ],
  },
};

export default moderationModule;
