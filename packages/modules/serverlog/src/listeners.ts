import {
  type AuditEntry,
  auditEntrySchema,
  type CachedMessage,
  type CorrelationStore,
  cachedMessageSchema,
  type EventListener,
  type EventType,
  labelOf,
  MESSAGE_CACHE_DEFAULT_TTL_MS,
  type MessageContentCache,
  type ModuleContext,
  type PendingLog,
  type ProtonActionExecuted,
  type ProtonEvent,
  protonActionExecutedSchema,
  RATE_WINDOW_GUILD_SCOPE,
  type RateWindowStore,
  toCachedMessage,
  type UserResolver,
} from '@proton/core';
import {
  entitySpecsForAuditAction,
  LOG_TRIGGER_TYPES,
  type LogEventSpec,
  specByKey,
  specForAction,
  specsForAuditAction,
  specsForEvent,
} from './catalogue.ts';
import type { ServerlogConfig } from './config.ts';
import type { LogExecutor } from './embed.ts';
import { DEFAULT_EMOJIS, type EmojiSet } from './emoji.ts';
import { actionExecutorId } from './executors.ts';
import { renderModerationAction } from './render/actions.ts';
import type { RenderInput, RenderResult } from './render/types.ts';
import { isIgnored, resolveDestination } from './routing.ts';
import type { ScreeningStore } from './screening.ts';

export const SERVERLOG_MODULE_ID = 'serverlog';

export const SERVERLOG_ACTOR = 'proton:serverlog';

export const LOG_BURST_LIMIT = 60;
export const LOG_BURST_WINDOW_MS = 60_000;

export const SERVERLOG_EVENT_TYPES: EventType[] = [...LOG_TRIGGER_TYPES];

export interface FlushRequest {
  guildId: string;
  actionType: number;
  targetId: string;
  delayMs: number;
}

export interface ServerlogDeps {
  correlation?: CorrelationStore;
  users?: UserResolver;
  emojis?: EmojiSet;
  botUserId?: string;
  burst?: RateWindowStore;
  screening?: ScreeningStore;
  dashboardUrl?: string;

  cache?: MessageContentCache;
  cacheTtlMs?: number;

  scheduleFlush?(request: FlushRequest): Promise<void>;

  graceMs?: number;
  now?(): number;
}

export function logIdempotencyKey(guildId: string, logKey: string, naturalKey: string): string {
  return `serverlog:${guildId}:${logKey}:${naturalKey}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  const payload = value;
  return typeof payload === 'string' ? payload : null;
}

interface EventFacts {
  channelId: string | null;
  actorId: string | null;
  actorIsBot: boolean;
}

function factsOf(event: ProtonEvent): EventFacts {
  const payload = record(event.payload);
  const user = record(payload?.user);
  const author = record(payload?.author);

  return {
    channelId: str(payload?.channel_id) ?? str(payload?.id),
    actorId: str(user?.id) ?? str(author?.id),
    actorIsBot: user?.bot === true || author?.bot === true,
  };
}

function auditFacts(entry: AuditEntry): EventFacts {
  return { channelId: null, actorId: entry.actorId, actorIsBot: false };
}

function byProton(deps: ServerlogDeps, entry: AuditEntry): boolean {
  return deps.botUserId !== undefined && entry.actorId === deps.botUserId;
}

function awaitsAction(deps: ServerlogDeps, spec: LogEventSpec, entry: AuditEntry): boolean {
  return spec.actionKinds !== undefined && byProton(deps, entry);
}

// Negated: Discord's audit action types are all positive, so a mark never meets a real pending log.
function markSlot(spec: LogEventSpec): number | null {
  const actionType = spec.auditActions?.[0];
  return spec.primary === 'entity' && actionType !== undefined ? -actionType : null;
}

async function markLoggedAsAction(
  deps: ServerlogDeps,
  guildId: string,
  spec: LogEventSpec,
  action: ProtonActionExecuted,
  occurredAt: number,
): Promise<void> {
  const slot = markSlot(spec);
  if (!deps.correlation || slot === null || !action.targetId || action.dryRun) return;

  await deps.correlation.putPending(guildId, slot, action.targetId, {
    logKey: spec.key,
    guildId,
    entity: action,
    occurredAt,
  });
}

async function loggedAsAction(
  deps: ServerlogDeps,
  guildId: string,
  spec: LogEventSpec,
  targetId: string,
): Promise<boolean> {
  const slot = markSlot(spec);
  if (!deps.correlation || slot === null || !spec.actionKinds) return false;

  const mark = await deps.correlation.takePending(guildId, slot, targetId);
  if (mark) await deps.correlation.putPending(guildId, slot, targetId, mark);

  return mark !== null;
}

async function takeCorrelated(
  store: CorrelationStore,
  guildId: string,
  actions: readonly number[],
  targetId: string,
): Promise<AuditEntry | null> {
  for (const actionType of actions) {
    const entry = await store.takeAudit(guildId, actionType, targetId);
    if (!entry) continue;

    // Put back: a ban is also a leave, and each of those logs correlates with this one entry.
    if (entitySpecsForAuditAction(actionType).length > 1) {
      await store.putAudit(guildId, actionType, targetId, entry);
    }

    return entry;
  }

  return null;
}

export function createServerlogListener(deps: ServerlogDeps): EventListener<ServerlogConfig> {
  return {
    types: SERVERLOG_EVENT_TYPES,
    async handler(event: ProtonEvent, ctx: ModuleContext<ServerlogConfig>): Promise<void> {
      if (!ctx.config.enabled) return;

      if (event.type === 'audit.entry') {
        await onAudit(deps, ctx, event);
        return;
      }

      if (event.type === 'proton.action_executed') {
        await onAction(deps, ctx, event);
        return;
      }

      await onEntity(deps, ctx, event);
    },
  };
}

async function onAudit(
  deps: ServerlogDeps,
  ctx: ModuleContext<ServerlogConfig>,
  event: ProtonEvent,
): Promise<void> {
  const parsed = auditEntrySchema.safeParse(event.payload);
  if (!parsed.success) return;

  const entry = parsed.data;
  if (isIgnored(ctx.config, auditFacts(entry))) return;

  // Proton's own actions arrive twice: once as this audit entry, once as proton.action_executed
  // with the case id, the module and the moderator who asked attached. The second is strictly
  // better, so the first is dropped rather than logged alongside it.
  for (const spec of byProton(deps, entry) ? [] : specsForAuditAction(entry.actionType)) {
    await emit(deps, ctx, spec, {
      entity: null,
      audit: entry,
      naturalKey: entry.entryId,
      occurredAt: event.occurredAt,
    });
  }

  const entitySpecs = entitySpecsForAuditAction(entry.actionType);
  if (!entry.targetId || !deps.correlation || entitySpecs.length === 0) return;

  const pending = await deps.correlation.takePending(
    entry.guildId,
    entry.actionType,
    entry.targetId,
  );
  const spec = pending ? specByKey(pending.logKey) : undefined;

  // Put back for its flush, which by then knows whether proton.action_executed logged it.
  if (pending && spec && awaitsAction(deps, spec, entry)) {
    await deps.correlation.putPending(entry.guildId, entry.actionType, entry.targetId, pending);
    await deps.correlation.putAudit(entry.guildId, entry.actionType, entry.targetId, entry);
    return;
  }

  if (pending && spec && !spec.suppressWhenCorrelated) {
    await emit(deps, ctx, spec, {
      entity: pending.entity,
      audit: entry,
      cached: cachedOf(pending),
      naturalKey: keyOf(spec, pending.entity, entry),
      occurredAt: pending.occurredAt,
    });
  }

  // Kept even after a pending log took it: the leave that follows a ban correlates with it too.
  if (!pending || entitySpecs.length > 1) {
    await deps.correlation.putAudit(entry.guildId, entry.actionType, entry.targetId, entry);
  }
}

async function onAction(
  deps: ServerlogDeps,
  ctx: ModuleContext<ServerlogConfig>,
  event: ProtonEvent,
): Promise<void> {
  const parsed = protonActionExecutedSchema.safeParse(event.payload);
  if (!parsed.success) return;

  const action = parsed.data;
  const spec = specForAction(action.kind);
  if (!spec) return;

  await markLoggedAsAction(deps, ctx.guildId, spec, action, event.occurredAt);

  if (isIgnored(ctx.config, { actorId: action.actorId })) return;

  await emit(deps, ctx, spec, {
    entity: event.payload,
    audit: null,
    executorId: actionExecutorId(event.payload, deps.botUserId ?? null),
    naturalKey: event.id,
    occurredAt: event.occurredAt,
    ...(spec.actionKinds ? { render: renderModerationAction } : {}),
  });
}

async function onEntity(
  deps: ServerlogDeps,
  ctx: ModuleContext<ServerlogConfig>,
  event: ProtonEvent,
): Promise<void> {
  const facts = factsOf(event);

  if (deps.botUserId && facts.actorId === deps.botUserId) return;
  if (isIgnored(ctx.config, facts)) return;

  if (event.type === 'member.joined' || event.type === 'member.updated') {
    await onScreening(deps, ctx, event);
  }

  const cached = await readCache(deps, ctx.guildId, event);

  for (const spec of specsForEvent(event.type)) {
    if (spec.key === SCREENING_PASSED) continue;

    if (spec.primary === 'immediate') {
      await emit(deps, ctx, spec, {
        entity: event.payload,
        audit: null,
        executorId: spec.executorId?.(event.payload, deps.botUserId ?? null) ?? null,
        cached,
        naturalKey: event.id,
        occurredAt: event.occurredAt,
      });
      continue;
    }

    const guildId = event.guildId ?? ctx.guildId;
    const targetId = spec.targetId?.(event.payload) ?? null;

    if (!targetId || !deps.correlation) {
      await emit(deps, ctx, spec, {
        entity: event.payload,
        audit: null,
        cached,
        naturalKey: targetId ?? event.id,
        occurredAt: event.occurredAt,
      });
      continue;
    }

    const actions = spec.auditActions ?? [];
    const correlated = await takeCorrelated(deps.correlation, guildId, actions, targetId);

    if (correlated && !awaitsAction(deps, spec, correlated)) {
      if (spec.suppressWhenCorrelated) continue;

      await emit(deps, ctx, spec, {
        entity: event.payload,
        audit: correlated,
        cached,
        naturalKey: targetId,
        occurredAt: event.occurredAt,
      });
      continue;
    }

    const primaryAction = actions[0];
    if (primaryAction === undefined) continue;

    // Proton's own ban waits for its flush like an uncorrelated log, and keeps its entry for it.
    if (correlated) {
      await deps.correlation.putAudit(guildId, correlated.actionType, targetId, correlated);
    }

    await deps.correlation.putPending(guildId, primaryAction, targetId, {
      logKey: spec.key,
      guildId,
      entity: event.payload,
      occurredAt: event.occurredAt,
      ...(cached ? { cached } : {}),
    });

    await deps.scheduleFlush?.({
      guildId,
      actionType: primaryAction,
      targetId,
      delayMs: deps.graceMs ?? 2_000,
    });
  }
}

const SCREENING_PASSED = 'members.screening_passed';

const UNBOUND_SCREENING =
  'a member is waiting on Membership Screening, but no screening store is wired into the ' +
  'worker, so "Member accepted the rules" will not be logged when they pass.';

async function onScreening(
  deps: ServerlogDeps,
  ctx: ModuleContext<ServerlogConfig>,
  event: ProtonEvent,
): Promise<void> {
  const payload = record(event.payload);
  const userId = str(record(payload?.user)?.id);
  if (!payload || !userId || typeof payload.pending !== 'boolean') return;

  const spec = specByKey(SCREENING_PASSED);
  if (!spec) return;

  const joinedAt = str(payload.joined_at) ?? '';

  if (payload.pending) {
    if (deps.screening) {
      await deps.screening.mark(ctx.guildId, userId, joinedAt);
    } else if (resolveDestination(ctx.config, spec)) {
      ctx.logger.error(UNBOUND_SCREENING, {
        guildId: ctx.guildId,
        moduleId: SERVERLOG_MODULE_ID,
        userId,
      });
    }
    return;
  }

  if (event.type !== 'member.updated' || !deps.screening) return;

  const marked = await deps.screening.read(ctx.guildId, userId);
  if (marked === null) return;

  if (marked === joinedAt) {
    await emit(deps, ctx, spec, {
      entity: event.payload,
      audit: null,
      // Keyed by membership, not event id: joinroles' post-pass role grant can read the same mark.
      naturalKey: `${userId}:${joinedAt}`,
      occurredAt: event.occurredAt,
    });
  }

  // Cleared after the post, not taken before it: a crash in between replays the same key instead.
  await deps.screening.clear(ctx.guildId, userId);
}

export async function flushPending(
  deps: ServerlogDeps,
  ctx: ModuleContext<ServerlogConfig>,
  request: Omit<FlushRequest, 'delayMs'>,
): Promise<void> {
  if (!ctx.config.enabled || !deps.correlation) return;

  const pending = await deps.correlation.takePending(
    request.guildId,
    request.actionType,
    request.targetId,
  );
  if (!pending) return;

  const spec = specByKey(pending.logKey);
  if (spec?.primary !== 'entity') return;

  if (await loggedAsAction(deps, request.guildId, spec, request.targetId)) return;

  // Proton's own ban waits here with its entry, and a leave is keyed as a kick but may be a ban.
  const audit = await takeCorrelated(
    deps.correlation,
    request.guildId,
    spec.auditActions ?? [],
    request.targetId,
  );
  if (audit && spec.suppressWhenCorrelated) return;

  // Still posted with no entry: a voluntary leave or a self-deleted message never gets one.
  await emit(deps, ctx, spec, {
    entity: pending.entity,
    audit,
    cached: cachedOf(pending),
    naturalKey: request.targetId,
    occurredAt: pending.occurredAt,
  });
}

function cachedOf(pending: PendingLog): CachedMessage | null {
  if (pending.cached === undefined) return null;

  const parsed = cachedMessageSchema.safeParse(pending.cached);
  return parsed.success ? parsed.data : null;
}

const CACHE_READ_TYPES: ReadonlySet<string> = new Set(['message.updated', 'message.deleted']);

async function readCache(
  deps: ServerlogDeps,
  guildId: string,
  event: ProtonEvent,
): Promise<CachedMessage | null> {
  if (!deps.cache || !CACHE_READ_TYPES.has(event.type)) return null;

  const messageId = str(record(event.payload)?.id);
  if (!messageId) return null;

  const cached = await deps.cache.get(guildId, messageId);
  if (!cached) return null;

  // Refresh after reading, never create: only the cache consumer may introduce an entry, so a
  // guild that has not opted in cannot gain one through the log path.
  if (event.type === 'message.deleted') {
    await deps.cache.delete(guildId, messageId);
  } else {
    const next = toCachedMessage(event.payload);
    if (next) {
      await deps.cache.put(
        guildId,
        messageId,
        { ...next, createdAt: cached.createdAt },
        deps.cacheTtlMs ?? MESSAGE_CACHE_DEFAULT_TTL_MS,
      );
    }
  }

  return cached;
}

function keyOf(spec: LogEventSpec, entity: unknown, entry: AuditEntry): string {
  return spec.targetId?.(entity) ?? entry.targetId ?? entry.entryId;
}

interface EmitInput {
  entity: unknown;
  audit: AuditEntry | null;
  executorId?: string | null;
  cached?: CachedMessage | null;
  naturalKey: string;
  occurredAt: number;
  render?(input: RenderInput): RenderResult | null;
}

async function emit(
  deps: ServerlogDeps,
  ctx: ModuleContext<ServerlogConfig>,
  spec: LogEventSpec,
  input: EmitInput,
): Promise<void> {
  const destination = resolveDestination(ctx.config, spec);
  if (!destination) return;

  const executor = await resolveExecutor(deps, input.audit?.actorId ?? input.executorId ?? null);

  const rendered = (input.render ?? spec.render)({
    guildId: ctx.guildId,
    entity: input.entity,
    audit: input.audit,
    cached: input.cached,
    executor,
    occurredAt: input.occurredAt,
    emojis: deps.emojis ?? DEFAULT_EMOJIS,
    commandLabel: (key, path) => labelOf(ctx, key, path),
    dashboardUrl: deps.dashboardUrl,
  });
  if (!rendered) return;

  const key = logIdempotencyKey(ctx.guildId, spec.key, input.naturalKey);
  if (await overBurstLimit(deps, ctx, destination.channelId, key)) return;

  const result = await ctx.executor.execute({
    guildId: ctx.guildId,
    moduleId: SERVERLOG_MODULE_ID,
    kind: 'send',
    actorId: SERVERLOG_ACTOR,
    reason: `Server log: ${spec.key}`,
    idempotencyKey: key,
    dryRun: false,

    record: false,

    payload: {
      channelId: destination.channelId,
      embeds: [rendered.embed],
      allowedMentions: { parse: [] },
    },
  });

  if (result.status === 'failed_precheck' || result.status === 'failed_api') {
    ctx.logger.error(
      `could not post the ${spec.label} log to <#${destination.channelId}>: ${
        result.failure?.humanReason ?? 'unknown reason'
      }`,
      { guildId: ctx.guildId, moduleId: SERVERLOG_MODULE_ID, logKey: spec.key },
    );
  }
}

async function resolveExecutor(
  deps: ServerlogDeps,
  actorId: string | null,
): Promise<LogExecutor | null> {
  if (!actorId || !deps.users) return null;

  const profile = await deps.users.resolve(actorId);
  if (!profile) return null;

  return { id: profile.id, username: profile.username, avatarUrl: profile.avatarUrl };
}

export const BURST_RULE_ID = 'serverlog:burst';

async function overBurstLimit(
  deps: ServerlogDeps,
  ctx: ModuleContext<ServerlogConfig>,
  channelId: string,
  member: string,
): Promise<boolean> {
  if (!deps.burst) return false;

  // The member is the log's own idempotency key, so a redelivered event lands on the same slot
  // (ZADD NX) instead of eating a second one.
  const result = await deps.burst.hit({
    guildId: ctx.guildId,
    ruleId: BURST_RULE_ID,
    actorId: RATE_WINDOW_GUILD_SCOPE,
    windowMs: LOG_BURST_WINDOW_MS,
    limit: LOG_BURST_LIMIT,
    member,
    now: deps.now?.() ?? Date.now(),
  });

  if (result.tripped) {
    await ctx.executor.execute({
      guildId: ctx.guildId,
      moduleId: SERVERLOG_MODULE_ID,
      kind: 'send',
      actorId: SERVERLOG_ACTOR,
      reason: 'Server log: throttled',
      idempotencyKey: `serverlog:${ctx.guildId}:throttle:${member}`,
      dryRun: false,
      record: false,
      payload: {
        channelId,
        content:
          `Server Logs reached ${LOG_BURST_LIMIT} logs in a minute, so it’s paused until ` +
          'activity slows down. Events in the meantime aren’t logged.',
        allowedMentions: { parse: [] },
      },
    });

    return true;
  }

  return result.count > LOG_BURST_LIMIT;
}
