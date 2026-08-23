import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import {
  SERVERLOG_SCHEMA_VERSION,
  serverlogConfigSchema,
  serverlogDefaultConfig,
  serverlogFormSchema,
} from './config.ts';
import { createServerlogListener, type ServerlogDeps } from './listeners.ts';

export {
  categoryOf,
  entitySpecsForAuditAction,
  isLogEventKey,
  LOG_CATEGORIES,
  LOG_EVENT_KEYS,
  LOG_EVENTS,
  LOG_TRIGGER_TYPES,
  type LogCategory,
  type LogEventSpec,
  type LogPrimary,
  specByKey,
  specsForAuditAction,
  specsForEvent,
} from './catalogue.ts';
export { type ServerLogColor, ServerLogColors } from './colours.ts';
export {
  LOG_CATEGORY_KEYS,
  LOG_TEXT_CHANNEL_TYPES,
  type LogEventOverride,
  logEventOverrideSchema,
  SERVERLOG_SCHEMA_VERSION,
  type ServerlogConfig,
  serverlogConfigSchema,
  serverlogDefaultConfig,
  serverlogFormSchema,
} from './config.ts';
export {
  DESCRIPTION_MAX,
  escapeInline,
  FIELD_VALUE_MAX,
  jumpUrl,
  type LogEmbedInput,
  type LogExecutor,
  type LogField,
  type LogLine,
  logBody,
  logEmbed,
  logLine,
  TITLE_MAX,
  timestampLine,
} from './embed.ts';
export {
  DEFAULT_EMOJIS,
  type EmojiIds,
  type EmojiSet,
  emojiSet,
  REPLY_FALLBACK,
  REPLY_NAME,
  STEM_FALLBACK,
  STEM_NAME,
} from './emoji.ts';
export {
  BURST_RULE_ID,
  createServerlogListener,
  type FlushRequest,
  flushPending,
  LOG_BURST_LIMIT,
  LOG_BURST_WINDOW_MS,
  logIdempotencyKey,
  SERVERLOG_ACTOR,
  SERVERLOG_EVENT_TYPES,
  SERVERLOG_MODULE_ID,
  type ServerlogDeps,
} from './listeners.ts';
export type { RenderInput, RenderResult } from './render/types.ts';
export {
  categoriesOn,
  type Destination,
  type IgnoreContext,
  isIgnored,
  logChannelIds,
  resolveDestination,
} from './routing.ts';

export function createServerlogModule(
  deps: ServerlogDeps = {},
): ModuleManifest<typeof serverlogConfigSchema> {
  return {
    id: 'serverlog',
    name: 'Server Logs',
    category: 'logging',
    configSchema: serverlogConfigSchema,
    formSchema: serverlogFormSchema,
    defaultConfig: serverlogDefaultConfig,
    schemaVersion: SERVERLOG_SCHEMA_VERSION,

    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
    ],

    // ViewAuditLog is what makes GUILD_AUDIT_LOG_ENTRY_CREATE arrive at all; without it most of
    // the catalogue is silent, and a silently half-working log module is worse than a disabled one.
    requiredPermissions: [
      Permissions.ViewChannel,
      Permissions.SendMessages,
      Permissions.EmbedLinks,
      Permissions.ViewAuditLog,
    ],
    actionKinds: ['send'],

    listeners: [createServerlogListener(deps)],

    dashboard: {
      icon: 'scroll-text',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'defaultChannelId'] },
        {
          id: 'categories',
          title: 'Categories',
          fields: ['categories', 'categoryChannels'],
        },
        {
          id: 'filters',
          title: 'Filters',
          fields: ['ignoredChannelIds', 'ignoredRoleIds', 'ignoredUserIds', 'ignoreBots'],
        },
      ],
    },
  };
}

export const serverlogModule: ModuleManifest<typeof serverlogConfigSchema> =
  createServerlogModule();

export default serverlogModule;
