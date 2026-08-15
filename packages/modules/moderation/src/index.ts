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

/**
 * The standard moderation commands (PLAN.md §8, phase 1).
 *
 * Every handler is a thin wrapper: read options, build one `ActionRequest`,
 * hand it to `ctx.executor`, repeat the executor's own failure reason back to
 * the moderator (I1, I8). No REST call, no permission arithmetic and no
 * hierarchy logic lives here — all of that is the executor's, so it cannot
 * disagree between commands or be forgotten by the next module.
 *
 * `/purge` is absent on purpose. Bulk delete needs the ids of the messages to
 * remove, which means listing the channel first — a REST call, which a module
 * may not make (I1/I2). It needs a core `purge` payload expressed as a count
 * that the executor resolves; adding it here would mean a module owning REST.
 */
export const moderationModule: ModuleManifest<typeof moderationConfigSchema> = {
  id: 'moderation',
  name: 'Moderation',
  category: 'moderation',
  configSchema: moderationConfigSchema,
  defaultConfig: moderationDefaultConfig,
  schemaVersion: MODERATION_SCHEMA_VERSION,
  // Commands arrive as interactions, which need no privileged intent. Nothing
  // here listens to messages or member updates.
  requiredIntents: [GatewayIntentBits.Guilds],
  // The union the invite URL is built from (§10.3). A bot missing any of these
  // has the module disabled with the missing permission named, rather than
  // discovering it one failed ban at a time.
  requiredPermissions: [
    Permissions.ViewChannel,
    Permissions.BanMembers,
    Permissions.KickMembers,
    Permissions.ModerateMembers,
    Permissions.ManageChannels,
    // Channel overwrites — what /lockdown and /unlock write — are governed by
    // MANAGE_ROLES, not MANAGE_CHANNELS.
    Permissions.ManageRoles,
  ],
  commands: [...memberCommands, ...channelCommands],
  /**
   * `/warn` publishes this so the `cases` module's escalation ladder has
   * something to trigger on (§4-P2).
   *
   * The allowlist is the reason this is safe to grant: `ModuleContext.publish`
   * refuses any type not listed here, so moderation cannot mint an
   * `xp.level_gained` or forge another module's events. It is also what tells
   * the registry's emission assertion that `moderation.warned` has a producer —
   * without it, `cases`' rules would be reported as triggering on something
   * nothing emits, which until now they genuinely were.
   */
  emits: ['moderation.warned'],
  migrations: [],
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
