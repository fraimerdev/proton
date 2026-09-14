import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { afkCommands } from './commands.ts';
import {
  AFK_EXPIRE_JOB,
  AFK_SCHEMA_VERSION,
  AFK_TIDY_JOB,
  afkConfigSchema,
  afkDefaultConfig,
  MODULE_ID,
} from './config.ts';
import type { AfkDeps } from './deps.ts';
import { createAfkListener } from './listener.ts';
import { expireAfk, tidyReply } from './scheduled.ts';

export { afkCommand, afkCommands } from './commands.ts';
export {
  AFK_EXPIRE_JOB,
  AFK_RETENTION_MS,
  AFK_SCHEMA_VERSION,
  AFK_TIDY_JOB,
  AFK_TOMBSTONE_MS,
  type AfkConfig,
  afkConfigSchema,
  afkDefaultConfig,
  IGNORED_CHANNELS_MAX,
  MODULE_ID,
  NOTICE_COOLDOWN_MS,
  REASON_MAX,
  RECAP_MAX,
  TIDY_DEFAULT,
  TIDY_MAX,
  TIDY_MIN,
  tidyDelayMs,
} from './config.ts';
export { type AfkDeps, bindStore, describeUnbound, type StoreBinding } from './deps.ts';
export {
  AFK_EVENT_TYPES,
  createAfkListener,
  handleConfigChanged,
  handleMemberLeft,
  handleMessage,
} from './listener.ts';
export {
  type AfkMessage,
  fromHuman,
  type MentionedUser,
  readMemberLeft,
  readMessage,
} from './message.ts';
export { DrizzleAfkStore } from './postgres-store.ts';
export {
  containsLink,
  normaliseReason,
  REASON_HAS_LINK,
  REASON_TOO_LONG,
  type ReasonResult,
} from './reason.ts';
export {
  AFK_TAG,
  displayName,
  escapeMarkdown,
  formatElapsed,
  isTagged,
  NOTICE_LINES_MAX,
  type NoticeEntry,
  nicknameProblem,
  plural,
  type RecapOutcome,
  renderNotice,
  renderRecap,
  renderRecapNote,
  renderWelcome,
  tagNickname,
  unixSeconds,
  untagged,
  type Whose,
} from './render.ts';
export { expireAfk, expireDataSchema, tidyDataSchema, tidyReply } from './scheduled.ts';
export {
  type EndedSession,
  type EndSessionOptions,
  endSession,
  type NickOutcome,
  type SessionFinish,
} from './session.ts';
export type {
  AfkPing,
  AfkStatus,
  AfkStore,
  RecordPingInput,
  StartAfkInput,
  StartAfkResult,
} from './store.ts';
export { type AfkPingRow, type AfkStatusRow, afkPings, afkStatuses } from './table.ts';

export function createAfkModule(deps: AfkDeps = {}): ModuleManifest<typeof afkConfigSchema> {
  return {
    id: MODULE_ID,
    name: 'AFK',
    category: 'utility',
    configSchema: afkConfigSchema,
    defaultConfig: afkDefaultConfig,
    schemaVersion: AFK_SCHEMA_VERSION,

    requiredIntents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
    ],

    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
    actionKinds: [
      'interaction_reply',
      'interaction_followup',
      'send',
      'delete_message',
      'create_dm',
      'set_member_nickname',
    ],

    commands: afkCommands(deps),
    listeners: [createAfkListener(deps)],

    schedules: [AFK_EXPIRE_JOB, AFK_TIDY_JOB],
    scheduledHandlers: {
      [AFK_EXPIRE_JOB]: (data, ctx) => expireAfk(data, ctx, deps),
      [AFK_TIDY_JOB]: (data, ctx) => tidyReply(data, ctx),
    },

    dashboard: {
      icon: 'moon',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled'] },
        {
          id: 'replies',
          title: 'Replies',
          fields: ['tidyReplies', 'tidyAfter', 'ignoredChannelIds'],
        },
        { id: 'nickname', title: 'Nickname', fields: ['nicknameTag'] },
        { id: 'recap', title: 'Coming back', fields: ['recap'] },
      ],
    },
  };
}

export const afkModule: ModuleManifest<typeof afkConfigSchema> = createAfkModule();

export default afkModule;
