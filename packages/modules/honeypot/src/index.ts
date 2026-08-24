import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  HONEYPOT_SCHEMA_VERSION,
  honeypotConfigSchema,
  honeypotDefaultConfig,
  honeypotFormSchema,
} from './config.ts';
import type { HoneypotDeps } from './deps.ts';
import { createHoneypotStatsListener } from './interactions.ts';
import { createHoneypotListener } from './listener.ts';
import { createHoneypotNoticeListener } from './service.ts';

export {
  CHANNELS_CEILING,
  channelFor,
  DELETE_SECONDS_MAX,
  describeWindow,
  HONEYPOT_ACTIONS,
  HONEYPOT_ACTOR,
  HONEYPOT_SCHEMA_VERSION,
  type HoneypotAction,
  type HoneypotChannel,
  type HoneypotConfig,
  honeypotChannelSchema,
  honeypotChannelsSchema,
  honeypotConfigSchema,
  honeypotDefaultConfig,
  honeypotFormSchema,
  MODULE_ID,
  SECONDS_PER_DAY,
} from './config.ts';
export {
  type BindResult,
  type BoundHoneypotDeps,
  bindHoneypotDeps,
  describeUnbound,
  type HoneypotDeps,
} from './deps.ts';
export { buildIncidentEmbed, HONEYPOT_ALARM, HONEYPOT_OK, type Incident } from './embed.ts';
export {
  createHoneypotStatsListener,
  HONEYPOT_STATS_EVENT_TYPES,
  handleStatsPress,
  type StatsOutcome,
} from './interactions.ts';
export {
  createHoneypotListener,
  HONEYPOT_EVENT_TYPES,
  handleMessage,
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
  HONEYPOT_COLOUR,
  HONEYPOT_POT,
  type NoticeResult,
  STATS_ACTION,
  type StatsView,
} from './notice.ts';
export { planTrap, type TrapPlan, type TrapPlanResult, type TrapStep } from './plan.ts';
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
  HONEYPOT_CAUGHT_PREFIX,
  HONEYPOT_LOCK_PREFIX,
  HONEYPOT_LOCK_TTL_MS,
  HONEYPOT_NOTICE_PREFIX,
  HONEYPOT_REFRESH_PREFIX,
  HONEYPOT_STATS_PREFIX,
  type HoneypotLock,
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
  RedisHoneypotLock,
  RedisHoneypotStatsStore,
  RedisNoticeStore,
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

    // No MessageContent: the trap is that a message exists at all, so Proton never reads one. That
    // is worth keeping true — it is the difference between this module needing a privileged intent
    // and not needing one.
    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],

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
    ],

    emits: ['proton.security_tripped'],

    configLimits: [{ key: 'honeypotChannels', path: 'channels' }],

    listeners: [
      createHoneypotListener(deps),
      createHoneypotNoticeListener(deps),
      createHoneypotStatsListener(deps),
    ],

    dashboard: {
      icon: 'fish',
      sections: [
        {
          id: 'honeypot',
          title: 'Honeypot',
          fields: ['enabled', 'includeThreads', 'logChannelId'],
        },
      ],
    },
  };
}

export const honeypotModule: ModuleManifest<typeof honeypotConfigSchema> = createHoneypotModule();

export default honeypotModule;
