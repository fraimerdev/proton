import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { giveawayCommands } from './commands.ts';
import {
  GIVEAWAYS_SCHEMA_VERSION,
  giveawaysConfigSchema,
  giveawaysDefaultConfig,
} from './config.ts';
import type { GiveawaysDeps } from './deps.ts';
import {
  createBuilderModalListener,
  createEnterListener,
  createGiveawayAutocompleteListener,
} from './listeners.ts';
import { createGiveawayProviders } from './providers.ts';
import {
  CLAIM_JOB_ID,
  createClaimHandler,
  createEndHandler,
  createFlushHandler,
  createReconcileHandler,
  END_JOB_ID,
  FLUSH_JOB_ID,
  RECONCILE_JOB_ID,
} from './schedule.ts';

export { publishResult, refreshMessage } from './announce.ts';
export {
  AUTOCOMPLETED_COMMAND,
  type AutocompleteOutcome,
  choiceFor,
  GIVEAWAY_OPTION,
  handleAutocomplete,
  stateFor,
} from './autocomplete.ts';
export {
  type BuilderDeps,
  type BuilderReply,
  type BuilderRoute,
  builderRouteOf,
  handleBuilderComponent,
  handleBuilderModal,
  isBuilderAction,
  startFromDraft,
} from './builder/handler.ts';
export {
  type BuilderOutcome,
  handleBuilderPress,
  handleBuilderSubmit,
} from './builder/interactions.ts';
export {
  type BuildModalResult,
  descriptorsToModal,
  type ReadValuesResult,
  readDescriptorValues,
} from './builder/modal.ts';
export {
  BASICS_MODAL,
  BUILDER_ADD_MULTIPLIER,
  BUILDER_ADD_REQUIREMENT,
  BUILDER_BASICS,
  BUILDER_CANCEL,
  BUILDER_LOGIC,
  BUILDER_PREVIEW,
  BUILDER_REMOVE,
  BUILDER_START,
  basicsModal,
  builderScreen,
  ITEM_MODAL,
  type ScreenResult,
} from './builder/screens.ts';
export {
  DRAFT_PREFIX,
  DRAFT_TTL_MS,
  type DraftItem,
  type DraftMultiplier,
  type DraftStore,
  draftKey,
  emptyDraft,
  type GiveawayDraft,
  MemoryDraftStore,
  RedisDraftStore,
} from './builder/state.ts';
export { giveawayCommand, giveawayCommands } from './commands.ts';
export {
  COUNT_FLUSH_INTERVAL_MS,
  DAY_MS,
  DEFAULT_CLAIM_WINDOW_SECONDS,
  DESCRIPTION_MAX,
  type DurationResult,
  describeWait,
  GIVEAWAY_LIST_MAX,
  GIVEAWAYS_SCHEMA_VERSION,
  type GiveawaysConfig,
  giveawaysConfigSchema,
  giveawaysDefaultConfig,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  MODULE_ID,
  MULTIPLIERS_MAX,
  parseGiveawayDuration,
  plural,
  REQUIREMENTS_MAX,
  TITLE_MAX,
  WINNER_COUNT_MAX,
} from './config.ts';
export {
  DIRTY_SET_KEY,
  type DirtyCounts,
  FLUSH_LEASE_PREFIX,
  type FlushDeps,
  type FlushOutcome,
  flushCounts,
  MemoryDirtyCounts,
  RedisDirtyCounts,
} from './counter.ts';
export {
  type BindResult,
  type BoundBuilder,
  type BoundDraw,
  type BoundEntry,
  type BoundStore,
  bindDraw,
  bindEntry,
  bindStore,
  clockOf,
  describeUnbound,
  type GiveawaysDeps,
} from './deps.ts';
export {
  drawWinners,
  Reservoir,
  sampleWeighted,
  sampleWeightedAsync,
  type WeightedEntrant,
} from './draw.ts';
export {
  type CancelOutcome,
  cancelGiveaway,
  DRAW_CHUNK_SIZE,
  type DrawDeps,
  type DrawInput,
  type DrawOutcome,
  type DrawSummary,
  drawGiveaway,
  drawKey,
} from './end.ts';
export {
  AllowAllBucket,
  describeJoin,
  ENTRY_BUCKET_PREFIX,
  ENTRY_BUCKET_WINDOW_MS,
  type EntryBucket,
  isBlacklisted,
  type JoinDeps,
  type JoinInput,
  type JoinOutcome,
  join,
  RedisEntryBucket,
  snapshotOf,
} from './entry.ts';
export {
  type EnterId,
  type EnterOutcome as EnterPressOutcome,
  handleEnter,
  readEnterId,
} from './interactions.ts';
export {
  AUTOCOMPLETE_EVENT_TYPES,
  COMPONENT_EVENT_TYPES,
  createBuilderModalListener,
  createEnterListener,
  createGiveawayAutocompleteListener,
  GIVEAWAYS_EVENT_TYPES,
  MODAL_EVENT_TYPES,
} from './listeners.ts';
export {
  announcement,
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  BUTTON_SUCCESS,
  buildEntryRow,
  CLAIM_ACTION,
  COUNT_ACTION,
  type ComponentsResult,
  claimRow,
  countedRow,
  ENTER_ACTION,
  ENTRY_BUTTON_STYLES,
  endedMessage,
  type GiveawayView,
  type ListEntry,
  type MessageComponent,
  mentionAll,
  messageLink,
  renderList,
  rerollAnnouncement,
  runningMessage,
  V2_FLAGS,
  viewOf,
} from './message.ts';
export {
  announceWinners,
  editGiveaway,
  MENTIONS_OFF,
  NOT_WIRED,
  postGiveaway,
  type ReplyOptions,
  recordDrawCase,
  reply,
  sentMessageId,
  succeeded,
} from './perform.ts';
export { DrizzleGiveawayStore } from './postgres-store.ts';
export { createGiveawayProviders } from './providers.ts';
export {
  type ReconcileDeps,
  type ReconcileResult,
  reconcile,
  STALE_DRAW_AFTER_MS,
} from './reconcile.ts';
export { type RerollInput, type RerollOutcome, rerollGiveaway } from './reroll.ts';
export {
  CLAIM_JOB_ID,
  createClaimHandler,
  createEndHandler,
  createFlushHandler,
  createReconcileHandler,
  END_JOB_ID,
  endJobDataSchema,
  FLUSH_JOB_ID,
  GIVEAWAY_JOB_IDS,
  RECONCILE_JOB_ID,
} from './schedule.ts';
export {
  canonicalise,
  canonicalOrder,
  type EntrantSnapshot,
  isCanonicallyOrdered,
  StreamingSnapshotHash,
  snapshotHash,
  totalEntriesOf,
} from './snapshot.ts';
export {
  BLACKLIST_SUBJECTS,
  type BlacklistEntry,
  type BlacklistSubject,
  type CreateGiveawayInput,
  type Disqualification,
  type DrawRecord,
  type EnterOutcome,
  type EntrantRow,
  GIVEAWAY_STATUSES,
  type Giveaway,
  type GiveawayStatus,
  type GiveawayStore,
  type ListGiveawaysQuery,
  type MemberSnapshot,
  type MultiplierRow,
  type NewEntry,
  REQUIREMENT_LOGICS,
  type RecordDrawInput,
  type RequirementLogic,
  type RequirementRow,
  type Reweigh,
  type TemplateRecord,
  VERIFY_ON,
  type VerifyOn,
  type WinRecord,
} from './store.ts';
export {
  type GiveawayBlacklistRow,
  type GiveawayDrawRow,
  type GiveawayEntryRow,
  type GiveawayMultiplierRow,
  type GiveawayRequirementRow,
  type GiveawayRow,
  type GiveawayTemplateRow,
  type GiveawayWinRow,
  giveawayBlacklist,
  giveawayDraws,
  giveawayEntries,
  giveawayMultipliers,
  giveawayRequirements,
  giveaways,
  giveawayTemplates,
  giveawayWins,
  type NewGiveawayEntryRow,
  type NewGiveawayRow,
} from './table.ts';
export { type TemplatePayload, templatePayloadSchema } from './templates.ts';

export function createGiveawaysModule(
  deps: GiveawaysDeps = {},
): ModuleManifest<typeof giveawaysConfigSchema> {
  return {
    id: 'giveaways',
    name: 'Giveaways',
    category: 'engagement',
    configSchema: giveawaysConfigSchema,
    defaultConfig: giveawaysDefaultConfig,
    schemaVersion: GIVEAWAYS_SCHEMA_VERSION,

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
      'giveaway_draw',
      'create_dm',
    ],

    commands: giveawayCommands(deps),
    listeners: [
      createEnterListener(deps),
      createGiveawayAutocompleteListener(deps),
      createBuilderModalListener(deps),
    ],

    // Registered only when the store is bound: a requirement nobody can ever evaluate should not
    // show up in another module's picker.
    ...(deps.store ? { providers: createGiveawayProviders(deps.store) } : {}),

    schedules: [END_JOB_ID, FLUSH_JOB_ID, RECONCILE_JOB_ID, CLAIM_JOB_ID],
    scheduledHandlers: {
      [END_JOB_ID]: createEndHandler(deps),
      [FLUSH_JOB_ID]: createFlushHandler(deps),
      [RECONCILE_JOB_ID]: createReconcileHandler(deps),
      [CLAIM_JOB_ID]: createClaimHandler(deps),
    },

    configLimits: [{ key: 'activeGiveaways', path: 'enabled' }],

    dashboard: {
      icon: 'gift',
      sections: [
        {
          id: 'general',
          title: 'General',
          fields: ['enabled', 'defaultWinnerCount', 'embedColor'],
        },
        {
          id: 'results',
          title: 'Results',
          fields: ['announceInChannel', 'dmWinners', 'claimWindowSeconds'],
        },
        { id: 'logging', title: 'Logging', fields: ['logChannelId'] },
      ],
    },
  };
}

export const giveawaysModule: ModuleManifest<typeof giveawaysConfigSchema> =
  createGiveawaysModule();

export default giveawaysModule;
