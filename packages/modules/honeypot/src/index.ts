import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { CAMO_JOB, createCamouflageHandler, createCamouflageListener } from './camouflage.ts';
import {
  HONEYPOT_SCHEMA_VERSION,
  honeypotConfigSchema,
  honeypotDefaultConfig,
  honeypotFormSchema,
  liftStoredConfig,
} from './config.ts';
import type { HoneypotDeps } from './deps.ts';
import { createHoneypotStatsListener } from './interactions.ts';
import { createHoneypotListener } from './listener.ts';
import { createHoneypotPendingListener } from './pending.ts';
import { PUNISH_JOB } from './punish.ts';
import { createPunishHandler } from './punish-handler.ts';
import { createHoneypotNoticeListener } from './service.ts';

export {
  CAMO_EVENT_TYPES,
  CAMO_INTERVAL_MS,
  CAMO_JOB,
  CAMO_KEY,
  type CamouflageOutcome,
  type CamouflageSchedule,
  camouflageName,
  createCamouflageHandler,
  createCamouflageListener,
  daySlot,
  KEEP_ALIVE_LINES,
  NAME_SUFFIXES,
  reconcileCamouflage,
  runCamouflage,
  wanted,
} from './camouflage.ts';
export {
  AUDIT_REASON_MAX,
  CHANNELS_CEILING,
  channelFor,
  DEFAULT_AUDIT_REASON,
  DEFAULT_DM_MESSAGE,
  DEFAULT_NOTICE_MESSAGE,
  DELETE_SECONDS_MAX,
  describeWindow,
  HONEYPOT_ACTIONS,
  HONEYPOT_ACTOR,
  HONEYPOT_COLOUR,
  HONEYPOT_PANEL_KEYS,
  HONEYPOT_SCHEMA_VERSION,
  type HoneypotAction,
  type HoneypotChannel,
  type HoneypotConfig,
  type HoneypotLayout,
  honeypotChannelSchema,
  honeypotChannelsSchema,
  honeypotConfigSchema,
  honeypotDefaultConfig,
  honeypotFormSchema,
  honeypotLayoutSchema,
  liftStoredConfig,
  MODULE_ID,
  SECONDS_PER_DAY,
  WAIT_SECONDS_MAX,
} from './config.ts';
export {
  type BindResult,
  type BoundHoneypotDeps,
  bindHoneypotDeps,
  describeUnbound,
  type HoneypotDeps,
} from './deps.ts';
export {
  DM_RESULT_LABEL,
  type DmOutcome,
  sendDirectMessage,
} from './dm.ts';
export {
  buildIncidentEmbed,
  HONEYPOT_ALARM,
  HONEYPOT_OK,
  HONEYPOT_QUIET,
  type Incident,
  QUOTE_MAX,
  quoteForLog,
} from './embed.ts';
export {
  EXEMPT_LABEL,
  exemptReason,
  HONEYPOT_EXEMPT_REASONS,
  type HoneypotExemptReason,
} from './exempt.ts';
export {
  createHoneypotStatsListener,
  HONEYPOT_STATS_EVENT_TYPES,
  handleStatsPress,
  type StatsOutcome,
} from './interactions.ts';
export {
  APPEAL_KEY,
  COUNTER_KEY,
  DEFAULT_DM_LAYOUT,
  DEFAULT_NOTICE_LAYOUT,
  DM_BODY,
  DM_HEADING,
  HONEYPOT_POT,
  INVITE_KEY,
  NOTICE_BODY,
  NOTICE_HEADING,
  QUIET_NOTICE_BODY,
  RECOVERY_ADVICE,
  refineHoneypotLayout,
} from './layout.ts';
export {
  createHoneypotListener,
  HONEYPOT_EVENT_TYPES,
  handleMessage,
  punishmentOf,
  spring,
  type TrapOutcome,
} from './listener.ts';
export {
  type IgnoreReason,
  ignoreReason,
  readMessage,
  type TrapMessage,
} from './message.ts';
export {
  buildNoticeComponents,
  buildStatsComponents,
  caughtLabel,
  consequenceOf,
  DM_ACTION_WORD,
  type LayoutSlot,
  layoutFor,
  type NoticeResult,
  purgeSentence,
  STATS_ACTION,
  type StatsView,
} from './notice.ts';
export {
  createHoneypotPendingListener,
  HONEYPOT_PENDING_EVENT_TYPES,
  markSettled,
  type PendingOutcome,
} from './pending.ts';
export {
  type Punishment,
  planTrap,
  punishmentSchema,
  type TrapPlan,
  type TrapPlanResult,
  type TrapStep,
} from './plan.ts';
export {
  PUNISH_JOB,
  type PunishData,
  punishDataSchema,
  schedulePunishment,
  type WaitOutcome,
} from './punish.ts';
export { createPunishHandler, runPunishment } from './punish-handler.ts';
export {
  createHoneypotNoticeListener,
  HONEYPOT_SERVICE_EVENT_TYPES,
  NOTICE_REFRESH_MS,
  type NoticeChange,
  type NoticeOutcome,
  reconcileNotices,
  refreshNoticeCount,
} from './service.ts';
export {
  CAUGHT_RETENTION_MS,
  type CaughtEntry,
  type CaughtInput,
  DM_ATTEMPTS_MAX,
  type DmChannelStore,
  EXEMPT_ACTION,
  HONEYPOT_CAUGHT_PREFIX,
  HONEYPOT_DM_PREFIX,
  HONEYPOT_LOCK_PREFIX,
  HONEYPOT_LOCK_TTL_MS,
  HONEYPOT_NOTICE_PREFIX,
  HONEYPOT_REFRESH_PREFIX,
  HONEYPOT_STATS_PREFIX,
  HONEYPOT_TOMBSTONE_PREFIX,
  type HoneypotLock,
  type HoneypotPendingStore,
  type HoneypotStats,
  type HoneypotStatsStore,
  lockKey,
  type NoticeBook,
  type NoticeRecord,
  type NoticeStore,
  noticeBookSchema,
  noticeKey,
  noticeRecordSchema,
  RECENT_SHOWN,
  RedisDmChannelStore,
  RedisHoneypotLock,
  RedisHoneypotPendingStore,
  RedisHoneypotStatsStore,
  RedisNoticeStore,
  TOMBSTONE_TTL_MS,
} from './store.ts';

export function createHoneypotModule(
  deps: HoneypotDeps = {},
): ModuleManifest<typeof honeypotConfigSchema> {
  return {
    id: 'honeypot',
    name: 'Honeypot',
    category: 'security',
    configSchema: honeypotConfigSchema,
    formSchema: honeypotFormSchema,
    defaultConfig: honeypotDefaultConfig,
    schemaVersion: HONEYPOT_SCHEMA_VERSION,

    liftStoredConfig,

    // MessageContent is declared because "Quote the message" puts what was posted in the incident
    // log. Nothing branches on the body — the trap is still that a message exists at all — but
    // reading it without declaring the intent would make the manifest a promise Proton was not
    // keeping.
    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],

    // The default action's permission, so a guild without it is told the module cannot function
    // rather than finding out at the first trap. The rest are named by the executor at fire time.
    requiredPermissions: [Permissions.BanMembers],

    actionKinds: [
      'ban',
      'unban',
      'kick',
      'timeout',
      'warn',
      'delete_message',
      'send',
      'edit_message',
      'interaction_reply',

      // The daily rename. Not in requiredPermissions: invitePermissions() unions actionKinds, so
      // Manage Channels reaches the bot invite, while requiring it would report the whole module
      // dead for every guild that never turned camouflage on.
      'edit_channel',
    ],

    emits: ['proton.security_tripped'],

    // The only allowlist the registry checks at boot, in both directions: a declared job with no
    // handler and a handler for no declared job both fail registration rather than dying in the
    // field days later.
    schedules: [PUNISH_JOB, CAMO_JOB],

    scheduledHandlers: {
      [PUNISH_JOB]: createPunishHandler(deps),
      [CAMO_JOB]: createCamouflageHandler(deps),
    },

    configLimits: [{ key: 'honeypotChannels', path: 'channels' }],

    listeners: [
      createHoneypotListener(deps),
      createHoneypotNoticeListener(deps),
      createHoneypotStatsListener(deps),
      createHoneypotPendingListener(deps),
      createCamouflageListener(),
    ],

    dashboard: {
      icon: 'fish',
      sections: [
        { id: 'bait', title: 'Bait channels', fields: ['enabled', 'includeThreads'] },
        {
          id: 'camouflage',
          title: 'Camouflage',
          fields: ['keepChannelActive', 'renameChannelDaily'],
        },
        {
          id: 'action',
          title: 'What happens',
          fields: [
            'action',
            'timeoutFirst',
            'timeoutFirstDuration',
            'timeoutDuration',
            'deleteMessageSeconds',
            'waitBeforeActingSeconds',
            'auditLogReason',
            'deleteTriggerMessage',
          ],
        },
        {
          id: 'exemptions',
          title: 'Who is exempt',
          fields: ['exemptAdministrators', 'exemptAdminRoleId', 'exemptRoleIds'],
        },
        {
          id: 'notice',
          title: 'The warning message',
          fields: ['postNotice', 'noticeCounterButton', 'hideWhatIsAHoneypot'],
        },
        {
          id: 'dm',
          title: 'The direct message',
          fields: ['sendDirectMessage', 'offerWayBackIn', 'inviteUrl'],
        },
        {
          id: 'escalation',
          title: 'Escalation and logging',
          fields: ['addToBlacklist', 'quoteMessage', 'logChannelId'],
        },
      ],
    },
  };
}

export const honeypotModule: ModuleManifest<typeof honeypotConfigSchema> = createHoneypotModule();

export default honeypotModule;
