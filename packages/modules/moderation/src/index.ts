import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { channelCommands } from './commands/channel.ts';
import { memberCommands } from './commands/member.ts';
import { roleCommand } from './commands/role.ts';
import {
  liftStoredConfig,
  MODERATION_SCHEMA_VERSION,
  moderationConfigSchema,
  moderationDefaultConfig,
  moderationFormSchema,
} from './config.ts';
import type { ModerationDeps } from './deps.ts';
import { escalationRules, moderationPresetRules } from './escalation.ts';
import { createRoleRunHandler, ROLE_RUN_JOB } from './role-run.ts';

export { channelCommands, lockdownCommand, slowmodeCommand } from './commands/channel.ts';
export {
  banCommand,
  kickCommand,
  memberCommands,
  timeoutCommand,
  warnCommand,
} from './commands/member.ts';
export { roleCommand } from './commands/role.ts';
export {
  ESCALATION_ACTIONS,
  type EscalationAction,
  type EscalationRung,
  escalationLadderSchema,
  escalationRungSchema,
  liftStoredConfig,
  MODERATION_SCHEMA_VERSION,
  type ModerationConfig,
  moderationConfigSchema,
  moderationDefaultConfig,
  moderationFormSchema,
} from './config.ts';
export type { ModerationDeps } from './deps.ts';
export { escalationRuleId, escalationRules, moderationPresetRules } from './escalation.ts';
export {
  type GuildMemberLister,
  type GuildMemberSummary,
  type MemberPage,
  type MemberPageResult,
  RestGuildMemberLister,
} from './members.ts';
export { MODULE_ID } from './perform.ts';
export { guardRole, type RoleGuardInput } from './role-guard.ts';
export {
  createRoleRunHandler,
  matchesRun,
  ROLE_RUN_JOB,
  ROLE_RUN_KEY,
  ROLE_RUN_PAGE,
  renderFinished,
  renderProgress,
} from './role-run.ts';
export {
  ROLE_RUN_MODES,
  type RoleRun,
  type RoleRunMode,
  type RoleRunStore,
  roleRunSchema,
} from './run-store.ts';
export type { StandingWarning, WarningStore, WithdrawInput } from './store.ts';

export function createModerationModule(
  deps: ModerationDeps = {},
): ModuleManifest<typeof moderationConfigSchema> {
  return {
    ...moderationModule,
    commands: [...memberCommands(deps), ...channelCommands, roleCommand(deps)],
    scheduledHandlers: { [ROLE_RUN_JOB]: createRoleRunHandler(deps) },
  };
}

export const moderationModule: ModuleManifest<typeof moderationConfigSchema> = {
  id: 'moderation',
  name: 'Moderation',
  category: 'moderation',
  configSchema: moderationConfigSchema,

  formSchema: moderationFormSchema,
  defaultConfig: moderationDefaultConfig,
  schemaVersion: MODERATION_SCHEMA_VERSION,
  liftStoredConfig,

  requiredIntents: [GatewayIntentBits.Guilds],

  requiredPermissions: [
    Permissions.ViewChannel,
    Permissions.SendMessages,
    Permissions.BanMembers,
    Permissions.KickMembers,
    Permissions.ModerateMembers,
    Permissions.ManageChannels,

    Permissions.ManageRoles,
  ],
  actionKinds: [
    'warn',
    'unwarn',
    'ban',
    'unban',
    'kick',
    'timeout',
    'untimeout',
    'slowmode',
    'lockdown',
    'unlock',
    'add_role',
    'remove_role',
    'send',
    'edit_message',
    'interaction_reply',
    'interaction_followup',
  ],
  commands: [...memberCommands({}), ...channelCommands, roleCommand({})],

  schedules: [ROLE_RUN_JOB],
  scheduledHandlers: { [ROLE_RUN_JOB]: createRoleRunHandler({}) },

  emits: ['moderation.warned'],
  rules: moderationPresetRules,
  compileRules: (config) => escalationRules(config),
  dashboard: {
    icon: 'shield',
    sections: [
      { id: 'general', title: 'General', fields: ['enabled', 'publicReplies'] },
      {
        id: 'policy',
        title: 'Policy',
        fields: ['requireReason', 'defaultTimeoutDuration', 'defaultBanDeleteDays'],
      },
      {
        id: 'escalation',
        title: 'Warn escalation',
        fields: ['escalationWindow', 'escalationLadder'],
      },
    ],
  },
};

export default moderationModule;
