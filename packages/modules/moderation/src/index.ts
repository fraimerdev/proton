import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { channelCommands } from './commands/channel.ts';
import { memberCommands } from './commands/member.ts';
import { reportCommand } from './commands/report.ts';
import { roleCommand } from './commands/role.ts';
import {
  liftStoredConfig,
  MODERATION_SCHEMA_VERSION,
  moderationConfigSchema,
  moderationDefaultConfig,
  moderationFormSchema,
  refineModerationWrite,
} from './config.ts';
import type { ModerationDeps } from './deps.ts';
import { escalationRules, moderationPresetRules } from './escalation.ts';
import { createReasonAutocompleteListener } from './interactions/autocomplete.ts';
import { createModerationInteractionListener } from './interactions/router.ts';
import { moderationTemplates } from './placeholders.ts';
import { createTimeoutJobHandler } from './punish/jobs.ts';
import { createPunishListeners } from './punish/listeners.ts';
import { punishAuthorMenu } from './punish/menu.ts';
import { TIMEOUT_JOB } from './punish/timeouts.ts';
import { PURGE_EVIDENCE_CRON, PURGE_EVIDENCE_JOB_ID } from './purge.ts';
import { createAutomationListener } from './reports/automation.ts';
import { createReportCloseHandler } from './reports/closing.ts';
import { createReportSubmittedListener, REPORT_CLOSE_JOB } from './reports/delivery.ts';
import { reportDirectInteractionGuild } from './reports/interactions.ts';
import { reportMessageMenu, reportUserMenu } from './reports/menus.ts';
import { createPatrolArmingListener, createPatrolHandler, PATROL_JOB } from './reports/patrol.ts';
import {
  createPromptCleanupHandler,
  createReportReactionListener,
  PROMPT_CLEANUP_JOB,
} from './reports/reaction.ts';
import { createReportRequestListener } from './reports/requests.ts';
import { acceptReport } from './reports/review.ts';
import { createRoleRunHandler, ROLE_RUN_JOB } from './role-run.ts';
import { moderationSimulations } from './simulation.ts';

export { channelCommands, lockdownCommand, slowmodeCommand } from './commands/channel.ts';
export {
  banCommand,
  kickCommand,
  memberCommands,
  timeoutCommand,
  warnCommand,
} from './commands/member.ts';
export { reportCommand } from './commands/report.ts';
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
export type { MemberLookup, MessageRead, ModerationDeps } from './deps.ts';
export { DRAFT_PREFIX, type DraftStore, newDraftId, RedisDraftStore } from './drafts.ts';
export { escalationRuleId, escalationRules, moderationPresetRules } from './escalation.ts';
export {
  createModerationInteractionListener,
  moderationInteractionHandler,
  UNKNOWN_CONTROL,
} from './interactions/router.ts';
export {
  type GuildMemberLister,
  type GuildMemberSummary,
  type MemberPage,
  type MemberPageResult,
  RestGuildMemberLister,
} from './members.ts';
export { MODULE_ID } from './perform.ts';
export { punishTemplates } from './placeholders.ts';
export {
  HISTORY_PREFIX,
  historyPattern,
  purgeGuild,
  RedisMessageHistoryBuffer,
  recordCreated,
  recordDeleted,
} from './punish/history.ts';
export { createTimeoutJobHandler, PUNISH_ACTOR } from './punish/jobs.ts';
export { createPunishListeners } from './punish/listeners.ts';
export { DM_CHANNEL_PREFIX, RedisDmChannelStore } from './punish/redis-store.ts';
export type {
  BufferedMessage,
  CaseLedger,
  CaseMessageStore,
  DmChannelStore,
  MessageHistoryBuffer,
  TimeoutStore,
} from './punish/store.ts';
export { TIMEOUT_JOB } from './punish/timeouts.ts';
export type { CommandGateResult } from './punish/types.ts';
export { PURGE_EVIDENCE_CRON, PURGE_EVIDENCE_JOB_ID, purgeModerationEvidence } from './purge.ts';
export { createReportCloseHandler } from './reports/closing.ts';
export {
  createReportSubmittedListener,
  handleCardDeleted,
  REPORT_CLOSE_JOB,
  runDeliveryPatrol,
} from './reports/delivery.ts';
export { REPORTS_ACTOR } from './reports/direct.ts';
export {
  REPORT_INTAKE_ACTIONS,
  REPORT_INTERACTION_ACTIONS,
  REPORT_REVIEW_ACTIONS,
  type ReportInteractionHandler,
  reportDirectInteractionGuild,
} from './reports/interactions.ts';
export {
  REPORT_MESSAGE_MENU,
  REPORT_USER_MENU,
  reportMenus,
  reportMessageMenu,
  reportUserMenu,
} from './reports/menus.ts';
export { createPatrolHandler, PATROL_JOB } from './reports/patrol.ts';
export { DrizzleReportStore } from './reports/postgres-store.ts';
export {
  createPromptCleanupHandler,
  createReportReactionListener,
  deletePrompt,
  PROMPT_CLEANUP_JOB,
} from './reports/reaction.ts';
export {
  PROMPT_SET_PREFIX,
  type PromptStore,
  REACTION_GATE_PREFIX,
  type ReactionGate,
  RedisPromptStore,
  RedisReactionGate,
} from './reports/redis-store.ts';
export { createReportRequestListener } from './reports/requests.ts';
export { acceptReport } from './reports/review.ts';
export type { ReportStore } from './reports/store.ts';
export { REPORT_COMMAND } from './reports/types.ts';
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
  const bound: ModerationDeps = { ...deps };
  bound.reportAccept ??= (ctx, request) => acceptReport(ctx, bound, request);

  return {
    id: 'moderation',
    name: 'Moderation',
    category: 'moderation',
    configSchema: moderationConfigSchema,

    formSchema: moderationFormSchema,
    defaultConfig: moderationDefaultConfig,
    schemaVersion: MODERATION_SCHEMA_VERSION,
    liftStoredConfig,
    refineWrite: refineModerationWrite,

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
      'create_dm',
      'delete_message',
      'remove_reaction',
      'move_member',
    ],
    commands: [
      ...memberCommands(bound),
      ...channelCommands(bound),
      roleCommand(bound),
      reportCommand(bound),
    ],
    contextMenus: [reportUserMenu(bound), reportMessageMenu(bound), punishAuthorMenu(bound)],
    directInteractionGuild: reportDirectInteractionGuild,

    listeners: [
      createModerationInteractionListener(bound),
      createReasonAutocompleteListener(bound),
      createReportReactionListener(bound),
      createReportSubmittedListener(bound),
      createAutomationListener(bound),
      createPatrolArmingListener(bound),
      createReportRequestListener(bound),
      ...createPunishListeners(bound),
    ],
    interactionConcurrency: 8,

    schedules: [ROLE_RUN_JOB, REPORT_CLOSE_JOB, PATROL_JOB, TIMEOUT_JOB, PROMPT_CLEANUP_JOB],
    scheduledWhileDisabled: [REPORT_CLOSE_JOB],
    scheduledHandlers: {
      [ROLE_RUN_JOB]: createRoleRunHandler(bound),
      [REPORT_CLOSE_JOB]: createReportCloseHandler(bound),
      [PATROL_JOB]: createPatrolHandler(bound),
      [TIMEOUT_JOB]: createTimeoutJobHandler(bound),
      [PROMPT_CLEANUP_JOB]: createPromptCleanupHandler(bound),
    },
    jobs: [{ id: PURGE_EVIDENCE_JOB_ID, cron: PURGE_EVIDENCE_CRON }],

    emits: [
      'moderation.warned',
      'moderation.report_submitted',
      'moderation.report_resolved',
      'moderation.punishment_expired',
    ],
    templates: moderationTemplates,
    simulations: moderationSimulations,
    rules: moderationPresetRules,
    compileRules: (config) => escalationRules(config),
    dashboard: {
      icon: 'shield',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'publicReplies'] },
        {
          id: 'escalation',
          title: 'Warn escalation',
          fields: ['escalationWindow', 'escalationLadder'],
        },
        { id: 'punish', title: 'Punishments', fields: ['punish'] },
        { id: 'reports', title: 'User reports', fields: ['reports'] },
      ],
    },
  };
}

export const moderationModule: ModuleManifest<typeof moderationConfigSchema> =
  createModerationModule();

export default moderationModule;
