export {
  CASE_PAGE_SIZE_DEFAULT,
  CASE_PAGE_SIZE_MAX,
  CASE_SORT_DIRECTIONS,
  CASE_SORT_FIELDS,
  type CaseQuery,
  type CaseQueryInput,
  type CaseRecord,
  type CaseSearchResult,
  type CaseSortDirection,
  type CaseSortField,
  caseQuerySchema,
} from './actions/case-query.ts';
export type { CaseInput, CaseRecorder } from './actions/case-recorder.ts';
export { DEDUPE_PREFIX, type DedupeStore, RedisDedupeStore } from './actions/dedupe.ts';
export { type ActionExecutorDeps, DefaultActionExecutor } from './actions/executor.ts';
export {
  ACTION_KINDS,
  type ActionKind,
  DESTRUCTIVE_KINDS,
  dryRunFor,
  isActionKind,
  isDestructive,
  isLedgerOnly,
  LEDGER_ONLY_KINDS,
  REQUIRED_PERMISSIONS,
  REVERSAL_OF,
  requiredPermissionsFor,
  reversalOf,
  TARGETS_MEMBER,
  targetsMember,
} from './actions/kinds.ts';
export * from './actions/payloads.ts';
export { type PrecheckInput, runPrechecks } from './actions/prechecks.ts';
export {
  type ResolveContextDeps,
  type ResolveContextHints,
  type ResolveContextResult,
  resolvePrecheckContext,
} from './actions/resolve-context.ts';
export {
  HttpRestProxyClient,
  type RestFile,
  type RestProxyClient,
  type RestRequestOptions,
  type RestResponse,
} from './actions/rest-client.ts';
export { type PayloadResult, type RestCall, toRestCall } from './actions/rest-mapping.ts';
export {
  AUTO_REVERSAL_ACTOR,
  planReversal,
  type ReversalPlan,
  type ReversalPlanResult,
  reversalIdempotencyKey,
} from './actions/reversal.ts';
export {
  DatabaseReversalScheduler,
  type ReversalSchedulerDeps,
} from './actions/reversal-scheduler.ts';
export {
  ReversalSweeper,
  type ReversalSweeperDeps,
  type SweepResult,
} from './actions/reversal-sweeper.ts';
export {
  type ClaimDueOptions,
  type CompleteReversalInput,
  type ScheduledActionInput,
  type ScheduledActionRecord,
  type ScheduledActionStore,
  type ScheduledReversalPayload,
  scheduledReversalPayloadSchema,
} from './actions/scheduled-actions.ts';
export {
  type ActionExecutor,
  type ActionFailure,
  type ActionRequest,
  type ActionResult,
  type ActionStatus,
  actionRequestSchema,
  isScopedActionExecutor,
  type ScopedActionExecutor,
} from './actions/types.ts';
export {
  type BooleanField,
  type ChannelIdField,
  type DurationField,
  type EnumField,
  type FieldDescriptor,
  type FieldKind,
  type FieldMetadata,
  type NumberField,
  protonFields,
  type RoleIdField,
  type StringField,
  UnsupportedSchemaError,
  zodToDescriptors,
} from './config/descriptor.ts';
export {
  durationStringSchema,
  formatDuration,
  InvalidDurationError,
  parseDuration,
  tryParseDuration,
} from './config/duration.ts';
export { createEnv, EnvValidationError } from './env.ts';
export {
  AUDIT_LOG_EVENT_TYPES,
  type AuditLogEventPayload,
  type AuditLogEventType,
  auditLogEventPayloadSchema,
  isAuditLogEventType,
  requiresAuditLog,
} from './events/audit-log.ts';
export type {
  EventBus,
  GroupStartId,
  SubscribeOptions,
  Subscription,
} from './events/bus.ts';
export {
  DLQ_PREFIX,
  dlqKey,
  RedisStreamsEventBus,
  type RedisStreamsEventBusOptions,
  STREAM_PREFIX,
  streamKey,
} from './events/redis-streams.ts';
export { EVENT_TYPES, type EventType, isEventType, type ProtonEvent } from './events/types.ts';
export { buildGuildState, parseChannel, parseOverwrites, parseRole } from './guild-state/build.ts';
export { GUILD_STATE_PREFIX, RedisGuildStateStore } from './guild-state/redis.ts';
export {
  type ChannelState,
  type GuildState,
  type GuildStatePatch,
  type GuildStateStore,
  highestRolePosition,
} from './guild-state/types.ts';
export { DISCORD_EPOCH_MS, newId, snowflakeCreatedAt } from './ids.ts';
export type {
  CommandContext,
  CommandDefinition,
  EventListener,
  Logger,
  Migration,
  ModuleCategory,
  ModuleContext,
  ModuleManifest,
  SectionDescriptor,
} from './modules/manifest.ts';
export {
  type CommandOptions,
  CommandOptionTypeError,
  createCommandOptions,
  OptionType,
  type RawOption,
} from './modules/options.ts';
export {
  type DisabledCode,
  ModuleRegistrationError,
  ModuleRegistry,
  type ModuleStatus,
  type RegistryEnvironment,
} from './modules/registry.ts';
export {
  ALL_PERMISSIONS,
  combinePermissions,
  has,
  hasWithAdmin,
  missing,
  Permissions,
  permissionNames,
} from './permissions/bits.ts';
export {
  applyOverwrites,
  computeBasePermissions,
  computeChannelPermissions,
  type GuildRole,
  type Overwrite,
  type PermissionContext,
} from './permissions/compute.ts';
export {
  type ConditionResult,
  evaluateFactCondition,
  type FactCondition,
  MAX_PATTERN_LENGTH,
  type RateOverWindowCondition,
  RULE_CONDITION_KINDS,
  type RuleCondition,
  type RuleConditionKind,
  ruleConditionSchema,
} from './rules/conditions.ts';
export {
  RULE_ENGINE_ACTOR,
  type RuleActionOutcome,
  RuleEngine,
  type RuleEngineDeps,
  type RuleEvaluationInput,
  type RuleEvaluationReport,
  type RuleFireInput,
  type RuleOutcome,
  type RuleSkip,
  type RuleSkipCode,
} from './rules/engine.ts';
export {
  ENTITLEMENT_TIERS,
  type EntitlementTier,
  entitlementRank,
  type RuleFacts,
} from './rules/facts.ts';
export {
  crossedKeyFor,
  RATE_WINDOW_GUILD_SCOPE,
  RATE_WINDOW_PREFIX,
  type RateWindowHit,
  type RateWindowResult,
  type RateWindowStore,
  RedisRateWindow,
  type RedisRateWindowOptions,
  rateWindowKey,
} from './rules/rate-window.ts';
export {
  type GuildRule,
  guildRuleSchema,
  type RuleAction,
  type RuleDefinition,
  type RuleTrigger,
  ruleActionSchema,
  ruleDefinitionSchema,
  ruleTriggerSchema,
  type ScheduledJob,
} from './rules/types.ts';
