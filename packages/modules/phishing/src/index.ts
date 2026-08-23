import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createPhishingStatusCommand } from './commands.ts';
import { PHISHING_SCHEMA_VERSION, phishingConfigSchema, phishingDefaultConfig } from './config.ts';
import type { PhishingDeps } from './deps.ts';
import { createPhishingListener } from './listener.ts';
import { BLOCKLIST_REFRESH_CRON, BLOCKLIST_REFRESH_JOB_ID } from './refresh.ts';

export {
  DOMAIN_MAX_LENGTH,
  domainCandidates,
  extractHosts,
  firstMatch,
  type HostCandidates,
  MAX_HOSTS_PER_MESSAGE,
  MAX_SUFFIXES_PER_HOST,
  messageCandidates,
  normaliseDomain,
  toDomainSet,
} from '@proton/core';
export { createPhishingStatusCommand } from './commands.ts';
export {
  PHISHING_ACTIONS,
  PHISHING_SCHEMA_VERSION,
  type PhishingAction,
  type PhishingConfig,
  phishingConfigSchema,
  phishingDefaultConfig,
} from './config.ts';
export {
  type BindResult,
  type BoundPhishingDeps,
  bindDeps,
  describeUnbound,
  type PhishingDeps,
} from './deps.ts';
export {
  type BlocklistLookup,
  type InspectedMessage,
  inspectMessage,
  type MatchSource,
  type PhishingVerdict,
  readMessage,
} from './detect.ts';
export {
  type BlocklistFeedOptions,
  type BlocklistFetch,
  DEFAULT_BLOCKLIST_FEEDS,
  FEED_MAX_BYTES,
  FEED_TIMEOUT_MS,
  FEED_USER_AGENT,
  type FeedFailure,
  type FeedResult,
  fetchBlocklist,
  parseFeedBody,
} from './feeds.ts';
export { createPhishingListener, MODULE_ID, PHISHING_EVENT_TYPES } from './listener.ts';
export {
  BLOCKLIST_PREFIX,
  BLOCKLIST_TTL_MS,
  RedisBlocklistStore,
  type RedisBlocklistStoreOptions,
} from './redis-store.ts';
export {
  BLOCKLIST_QUEUE,
  BLOCKLIST_REFRESH_CRON,
  BLOCKLIST_REFRESH_JOB_ID,
  type RefreshBlocklistDeps,
  type RefreshOutcome,
  refreshBlocklist,
} from './refresh.ts';
export type {
  BlocklistInstall,
  BlocklistStats,
  BlocklistStore,
} from './store.ts';

export function createPhishingModule(
  deps: PhishingDeps = {},
): ModuleManifest<typeof phishingConfigSchema> {
  return {
    id: 'phishing',
    name: 'Phishing links',
    category: 'security',
    configSchema: phishingConfigSchema,
    defaultConfig: phishingDefaultConfig,
    schemaVersion: PHISHING_SCHEMA_VERSION,

    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],

    requiredPermissions: [Permissions.ViewChannel],
    actionKinds: ['timeout', 'kick', 'ban', 'send', 'interaction_reply'],

    commands: [createPhishingStatusCommand(deps)],
    listeners: [createPhishingListener(deps)],

    jobs: [
      {
        id: BLOCKLIST_REFRESH_JOB_ID,
        cron: BLOCKLIST_REFRESH_CRON,
      },
    ],

    dashboard: {
      icon: 'fish',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'alertChannel'] },
        { id: 'response', title: 'Response', fields: ['action', 'timeoutDuration'] },
        { id: 'lists', title: 'Domain lists', fields: ['blockDomains', 'allowDomains'] },
      ],
    },
  };
}

export const phishingModule: ModuleManifest<typeof phishingConfigSchema> = createPhishingModule();

export default phishingModule;
