import { type ModuleManifest, Permissions } from '@proton/core';
import { GatewayIntentBits } from 'discord-api-types/v10';
import { createGiveawayCleanupListener } from './cleanup.ts';
import { giveawayCommands } from './commands.ts';
import {
  GIVEAWAYS_SCHEMA_VERSION,
  giveawaysConfigSchema,
  giveawaysDefaultConfig,
} from './config.ts';
import type { GiveawaysDeps } from './deps.ts';
import { GIVEAWAY_EMITS } from './events.ts';
import {
  createBuilderModalListener,
  createEnterListener,
  createGiveawayAutocompleteListener,
  createGiveawayPatrolListener,
} from './listeners.ts';
import { createGiveawayProviders } from './providers.ts';
import {
  CLAIM_JOB_ID,
  createClaimHandler,
  createEndHandler,
  createFlushHandler,
  createReconcileHandler,
  createStartHandler,
  END_JOB_ID,
  FLUSH_JOB_ID,
  RECONCILE_JOB_ID,
  START_JOB_ID,
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
export { blockingConflicts, type Conflict, findConflicts } from './builder/conflicts.ts';
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
  ITEM_MODAL,
  type ScreenResult,
} from './builder/screens.ts';
export {
  BUILDER_STEPS,
  type BuilderStep,
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
  STEP_HINTS,
  STEP_LABELS,
} from './builder/state.ts';
export {
  applyStepModal,
  STEP_MODAL,
  stepModal,
} from './builder/step-modals.ts';
export {
  BUILDER_CATEGORY,
  BUILDER_EDIT_STEP,
  BUILDER_ITEM_EDIT,
  BUILDER_ITEM_REMOVE,
  BUILDER_MODE,
  BUILDER_NAV,
  BUILDER_PICK,
  categoriesOf,
  categoryLabel,
  readyToPublish,
  type StepResult,
  stepScreen,
} from './builder/steps.ts';
export {
  CLEANUP_EVENT_TYPES,
  type CleanupOutcome,
  createGiveawayCleanupListener,
  handleChannelDeleted,
  handleMessageDeleted,
  readDeletedChannel,
  readDeletedMessages,
} from './cleanup.ts';
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
  ROLE_LIST_MAX,
  TITLE_MAX,
  WINNER_COUNT_MAX,
} from './config.ts';
export {
  DIRTY_SET_PREFIX,
  type DirtyCounts,
  dirtySetKey,
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
  buildActive,
  buildCancelled,
  buildDrawing,
  buildEnded,
  buildNoWinners,
  buildPaused,
  buildRerolled,
  buildScheduled,
  type CardInput,
  cardFor,
  GIVEAWAY_CARDS,
  type GiveawayCard,
  renderCard,
} from './embed.ts';
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
  GIVEAWAY_EMITS,
  publishBonus,
  publishCancelled,
  publishCreated,
  publishDrawn,
  publishEdited,
  publishOrphaned,
  publishPaused,
  publishResumed,
  publishStarted,
} from './events.ts';
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
  createGiveawayPatrolListener,
  GIVEAWAYS_EVENT_TYPES,
  MODAL_EVENT_TYPES,
  PATROL_EVENT_TYPES,
} from './listeners.ts';
export {
  announcement,
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  BUTTON_SUCCESS,
  CLAIM_ACTION,
  COUNT_ACTION,
  type ComponentsResult,
  claimRow,
  ENTER_ACTION,
  ENTRY_BUTTON_STYLES,
  type GiveawayView,
  LEAVE_ACTION,
  type ListEntry,
  type MessageComponent,
  MULTIPLIERS_ACTION,
  mentionAll,
  messageLink,
  REQUIREMENTS_ACTION,
  renderList,
  rerollAnnouncement,
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
  armPatrols,
  CLAIM_INTERVAL_MS,
  CLAIM_JOB_ID,
  CLAIM_KEY,
  createClaimHandler,
  createEndHandler,
  createFlushHandler,
  createReconcileHandler,
  createStartHandler,
  END_JOB_ID,
  endJobDataSchema,
  FLUSH_INTERVAL_MS,
  FLUSH_JOB_ID,
  FLUSH_KEY,
  GIVEAWAY_JOB_IDS,
  RECONCILE_INTERVAL_MS,
  RECONCILE_JOB_ID,
  RECONCILE_KEY,
  START_JOB_ID,
  startJobDataSchema,
} from './schedule.ts';
export {
  formatShortCode,
  newShortCode,
  parseShortCode,
  SHORT_CODE_ALPHABET,
  SHORT_CODE_LENGTH,
  SHORT_CODE_PREFIX,
} from './short-code.ts';
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
  BONUS_MAX,
  BONUS_MIN,
  type BonusGrant,
  type CreateGiveawayInput,
  type Disqualification,
  type DrawRecord,
  type EnterOutcome,
  type EntrantRow,
  GIVEAWAY_EVENT_KINDS,
  GIVEAWAY_STATUSES,
  type Giveaway,
  type GiveawayEvent,
  type GiveawayEventKind,
  type GiveawayStats,
  type GiveawayStatus,
  type GiveawayStore,
  type ListGiveawaysQuery,
  type MemberSnapshot,
  type MultiplierRow,
  type NewBonus,
  type NewEntry,
  type NewGiveawayEvent,
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
  type GiveawayBonusRow,
  type GiveawayDrawRow,
  type GiveawayEntryRow,
  type GiveawayEventRow,
  type GiveawayMultiplierRow,
  type GiveawayRequirementRow,
  type GiveawayRow,
  type GiveawayTemplateRow,
  type GiveawayWinRow,
  giveawayBlacklist,
  giveawayBonusEntries,
  giveawayDraws,
  giveawayEntries,
  giveawayEvents,
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

    emits: GIVEAWAY_EMITS,

    commands: giveawayCommands(deps),
    listeners: [
      createEnterListener(deps),
      createGiveawayAutocompleteListener(deps),
      createBuilderModalListener(deps),
      createGiveawayPatrolListener(deps),
      createGiveawayCleanupListener(deps),
    ],

    // Registered only when the store is bound: a requirement nobody can ever evaluate should not
    // show up in another module's picker.
    ...(deps.store ? { providers: createGiveawayProviders(deps.store) } : {}),

    schedules: [START_JOB_ID, END_JOB_ID, FLUSH_JOB_ID, RECONCILE_JOB_ID, CLAIM_JOB_ID],
    scheduledHandlers: {
      [START_JOB_ID]: createStartHandler(deps),
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
          id: 'access',
          title: 'Who can enter and who can manage',
          fields: ['managerRoleIds', 'bypassRoleIds', 'blacklistRoleIds'],
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
