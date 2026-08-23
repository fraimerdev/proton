import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { suggestionsCommands } from './commands.ts';
import {
  SUGGESTIONS_SCHEMA_VERSION,
  suggestionsConfigSchema,
  suggestionsDefaultConfig,
} from './config.ts';
import type { SuggestionsDeps } from './deps.ts';
import { createVoteListener } from './listeners.ts';

export { suggestCommand, suggestionCommand, suggestionsCommands } from './commands.ts';
export {
  type ContentResult,
  DECISION_REASON_MAX,
  MODULE_ID,
  normaliseSuggestion,
  SUGGESTION_CONTENT_MAX,
  SUGGESTION_NUMBER_MAX,
  SUGGESTIONS_SCHEMA_VERSION,
  type SuggestionsConfig,
  suggestionsConfigSchema,
  suggestionsDefaultConfig,
  trimReason,
} from './config.ts';
export {
  DECISIONS,
  type Decision,
  type DecisionOutcome,
  decide,
  isDecided,
  isDecision,
  isSuggestionStatus,
  SUGGESTION_STATUSES,
  type SuggestionStatus,
  statusFor,
  votingOpen,
} from './decide.ts';
export {
  type BindResult,
  type BoundDeps,
  bindDeps,
  describeUnbound,
  type SuggestionsDeps,
} from './deps.ts';
export {
  buildSuggestionEmbed,
  buildVoteRow,
  type ComponentsResult,
  DECIDER_HEADINGS,
  DESCRIPTION_MAX,
  DOWN_EMOJI,
  type Embed,
  type EmbedOptions,
  emojiFor,
  FIELD_VALUE_MAX,
  isVoteDirection,
  type MessageComponent,
  NO_VOTES,
  net,
  STATUS_COLOURS,
  STATUS_LABELS,
  type SuggestionView,
  signed,
  type Tally,
  threadName,
  UP_EMOJI,
  VOTE_ACTION,
  VOTE_DIRECTIONS,
  VOTE_VALUES,
  type VoteDirection,
} from './embed.ts';
export {
  describeTally,
  handleVote,
  readVotePress,
  type VoteOutcome as VotePressOutcome,
  type VotePress,
} from './interactions.ts';
export { createVoteListener, SUGGESTIONS_EVENT_TYPES } from './listeners.ts';
export {
  acknowledge,
  answer,
  createdId,
  type EditInput,
  editSuggestion,
  MENTIONS_OFF,
  NOT_WIRED,
  openThread,
  type PostInput,
  postSuggestion,
  respondTo,
  succeeded,
  THREAD_ARCHIVE_MINUTES,
  type ThreadInput,
  tell,
  whyItFailed,
} from './perform.ts';
export { DrizzleSuggestionStore } from './postgres-store.ts';
export type {
  AttachInput,
  CreateSuggestionInput,
  DecideSuggestionInput,
  Suggestion,
  SuggestionStore,
  VoteOutcome,
  VoteValue,
} from './store.ts';
export {
  type NewSuggestionRow,
  type NewSuggestionVoteRow,
  type SuggestionRow,
  type SuggestionVoteRow,
  suggestions,
  suggestionVotes,
} from './table.ts';

export function createSuggestionsModule(
  deps: SuggestionsDeps = {},
): ModuleManifest<typeof suggestionsConfigSchema> {
  return {
    id: 'suggestions',
    name: 'Suggestions',
    category: 'engagement',
    configSchema: suggestionsConfigSchema,
    defaultConfig: suggestionsDefaultConfig,
    schemaVersion: SUGGESTIONS_SCHEMA_VERSION,

    requiredIntents: [GatewayIntentBits.Guilds],

    requiredPermissions: [
      Permissions.ViewChannel,
      Permissions.SendMessages,
      Permissions.EmbedLinks,
    ],

    actionKinds: [
      'interaction_reply',
      'interaction_followup',
      'send',
      'edit_message',
      'create_thread',
    ],

    commands: suggestionsCommands(deps),
    listeners: [createVoteListener(deps)],

    dashboard: {
      icon: 'lightbulb',
      sections: [
        { id: 'general', title: 'General', fields: ['enabled', 'channelId'] },
        {
          id: 'posting',
          title: 'How suggestions are posted',
          fields: ['createThread', 'anonymous'],
        },
        { id: 'voting', title: 'Voting', fields: ['allowSelfVote'] },
      ],
    },
  };
}

export const suggestionsModule: ModuleManifest<typeof suggestionsConfigSchema> =
  createSuggestionsModule();

export default suggestionsModule;
