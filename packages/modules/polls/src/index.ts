import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { ANNOUNCE_JOB, createAnnounceHandler } from './announce.ts';
import { pollsCommands } from './commands.ts';
import { POLLS_SCHEMA_VERSION, pollsConfigSchema, pollsDefaultConfig } from './config.ts';
import type { PollsDeps } from './deps.ts';

export {
  ANNOUNCE_JOB,
  announceJobSchema,
  announceKey,
  type CloseOutcome,
  closePoll,
  createAnnounceHandler,
  renderAnnouncement,
} from './announce.ts';
export { POLL_LIST_MAX, pollCommand, pollsCommands, renderRunning } from './commands.ts';
export {
  ANSWER_SEPARATOR,
  type ComposeInput,
  type ComposeResult,
  closesAt,
  composePoll,
  POLL_MIN_ANSWERS,
  type PollRequest,
  splitAnswers,
} from './compose.ts';
export {
  MODULE_ID,
  POLL_DEFAULT_DURATION_HOURS,
  POLL_MIN_DURATION_HOURS,
  POLLS_SCHEMA_VERSION,
  type PollsConfig,
  pollLink,
  pollsConfigSchema,
  pollsDefaultConfig,
  unixSeconds,
} from './config.ts';
export {
  bindInteractive,
  bindStore,
  describeUnbound,
  type InteractiveBinding,
  type PollsDeps,
  type StoreBinding,
} from './deps.ts';
export { acknowledge, answer, MENTIONS_OFF, replyNow } from './perform.ts';
export { DrizzlePollStore } from './postgres-store.ts';
export type { CreatePollInput, PollRecord, PollStore } from './store.ts';
export { type NewPollRow, type PollRow, polls } from './table.ts';

export function createPollsModule(deps: PollsDeps = {}): ModuleManifest<typeof pollsConfigSchema> {
  return {
    id: 'polls',
    name: 'Polls',
    category: 'utility',
    configSchema: pollsConfigSchema,
    defaultConfig: pollsDefaultConfig,
    schemaVersion: POLLS_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessagePolls],

    requiredPermissions: [Permissions.ViewChannel, Permissions.SendMessages],
    actionKinds: ['interaction_reply', 'interaction_followup', 'send', 'end_poll'],

    commands: pollsCommands(deps),

    schedules: [ANNOUNCE_JOB],
    scheduledHandlers: { [ANNOUNCE_JOB]: createAnnounceHandler(deps) },

    dashboard: {
      icon: 'bar-chart-3',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'defaultDurationHours'] },
        {
          id: 'results',
          title: 'When a poll closes',
          fields: ['announceResults', 'announceChannelId'],
        },
      ],
    },
  };
}

export const pollsModule: ModuleManifest<typeof pollsConfigSchema> = createPollsModule();

export default pollsModule;
