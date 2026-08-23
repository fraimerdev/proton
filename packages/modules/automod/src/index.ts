import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { AUTOMOD_SCHEMA_VERSION, automodConfigSchema, automodDefaultConfig } from './config.ts';
import type { AutomodDeps } from './deps.ts';
import { createAutomodExecutionListener } from './execution.ts';
import { createAutomodListener } from './listener.ts';
import { createAutomodSyncListener } from './sync-listener.ts';

export {
  type AutomodHit,
  type Checker,
  capsRatio,
  checkAttachments,
  checkCaps,
  checkEmoji,
  checkInvites,
  checkLinks,
  checkMentions,
  checkPatterns,
  checkWalls,
  checkZalgo,
  countEmoji,
  maxCombiningStack,
  STATELESS_CHECKS,
} from './checks.ts';
export {
  type ActiveSeverity,
  AUTOMOD_CHECKS,
  AUTOMOD_SCHEMA_VERSION,
  type AutomodCheck,
  type AutomodConfig,
  type AutomodSettings,
  automodConfigSchema,
  automodDefaultConfig,
  DELETE_FROM,
  deletesAt,
  type KeywordPreset,
  outranks,
  RESPONSES,
  type Response,
  readSettings,
  responseFor,
  SEVERITIES,
  type Severity,
  severityOf,
} from './config.ts';
export {
  type AutomodDeps,
  type BindResult,
  type BoundAutomodDeps,
  bindDeps,
  describeUnbound,
  MODULE_ID,
} from './deps.ts';
export {
  AUTOMOD_EXECUTION_EVENT_TYPES,
  createAutomodExecutionListener,
  describeExecution,
  type ExecutionFacts,
  OWNED_RULES_TTL_MS,
  readExecution,
} from './execution.ts';
export {
  EXEMPT_REASONS,
  type ExemptInput,
  type ExemptReason,
  isExempt,
} from './exempt.ts';
export { AUTOMOD_EVENT_TYPES, createAutomodListener } from './listener.ts';
export {
  extensionOf,
  hasDoubleExtension,
  isHumanMessage,
  type MessageAttachment,
  type MessageFacts,
  normaliseForMatching,
  readMessage,
  stripCodeBlocks,
} from './message.ts';
export {
  type DesiredRule,
  diffNativeRules,
  type ExistingRule,
  isOwned,
  type NativeDiff,
  type NativeOp,
  type NativePlan,
  type PatternNote,
  PROTON_RULE_PREFIX,
  parseNativeRules,
  planNativeRules,
  RULE_NAMES,
} from './native.ts';
export {
  type AutomodVerdict,
  duplicateFingerprint,
  type ScreenInput,
  screen,
} from './pipeline.ts';
export {
  classifyRegex,
  NATIVE_REGEX_MAX_LENGTH,
  type RegexVerdict,
  type SplitPatterns,
  splitPatterns,
} from './regex-compat.ts';
export { type RespondInput, type RespondOutcome, respond } from './respond.ts';
export { type SyncInput, type SyncOutcome, syncNativeRules } from './sync.ts';
export { AUTOMOD_SYNC_EVENT_TYPES, createAutomodSyncListener } from './sync-listener.ts';

export function createAutomodModule(
  deps: AutomodDeps = {},
): ModuleManifest<typeof automodConfigSchema> {
  return {
    id: 'automod',
    name: 'Automod',
    category: 'security',
    configSchema: automodConfigSchema,
    defaultConfig: automodDefaultConfig,
    schemaVersion: AUTOMOD_SCHEMA_VERSION,

    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.AutoModerationConfiguration,
      GatewayIntentBits.AutoModerationExecution,
    ],

    // Only what screening a message needs. Manage Messages and Manage Server are each required by
    // one half, and hard-gating the module on either switches off the half that still works —
    // the executor precheck and the sync both name the missing permission where it actually bites.
    requiredPermissions: [Permissions.ViewChannel],
    actionKinds: [
      'delete_message',
      'warn',
      'timeout',
      'kick',
      'ban',
      'send',
      'automod_rule_create',
      'automod_rule_update',
      'automod_rule_delete',
    ],

    emits: ['moderation.warned'],

    listeners: [
      createAutomodListener(deps),
      createAutomodSyncListener(deps),
      createAutomodExecutionListener(deps),
    ],

    dashboard: {
      icon: 'shield-alert',
      sections: [
        {
          id: 'general',
          title: 'General',
          fields: ['enabled', 'alertChannelId'],
        },
        {
          id: 'exemptions',
          title: 'Exemptions',
          fields: ['exemptRoleIds', 'exemptChannelIds', 'exemptBots'],
        },
        {
          id: 'discord',
          title: 'Enforced by Discord',
          fields: [
            'blockedWords',
            'allowedWords',
            'presets',
            'mentionLimit',
            'nativeSpam',
            'regexPatterns',
          ],
        },
        {
          id: 'spam',
          title: 'Spam',
          fields: [
            'floodSeverity',
            'floodCount',
            'floodWindow',
            'duplicateSeverity',
            'duplicateCount',
            'duplicateWindow',
            'mentionsSeverity',
            'mentionsLimit',
          ],
        },
        {
          id: 'content',
          title: 'Content',
          fields: [
            'invitesSeverity',
            'linksSeverity',
            'linkBlockDomains',
            'linkAllowDomains',
            'attachmentsSeverity',
            'attachmentExtensions',
            'patternsSeverity',
          ],
        },
        {
          id: 'formatting',
          title: 'Formatting',
          fields: [
            'capsSeverity',
            'capsRatio',
            'emojiSeverity',
            'emojiLimit',
            'wallsSeverity',
            'wallMaxLines',
            'zalgoSeverity',
          ],
        },
        {
          id: 'response',
          title: 'Response',
          fields: [
            'deleteFrom',
            'lowResponse',
            'mediumResponse',
            'highResponse',
            'mediumTimeout',
            'highTimeout',
          ],
        },
      ],
    },
  };
}

export const automodModule: ModuleManifest<typeof automodConfigSchema> = createAutomodModule();

export default automodModule;
