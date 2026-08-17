import {
  type AuditEntry,
  auditEntrySchema,
  type CachedMessage,
  type CorrelationStore,
  cachedMessageSchema,
  type EventListener,
  type EventType,
  MESSAGE_CACHE_DEFAULT_TTL_MS,
  type MessageContentCache,
  type ModuleContext,
  type PendingLog,
  type ProtonEvent,
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
  specsForAuditAction,
  specsForEvent,
} from './catalogue.ts';
import type { ServerlogConfig } from './config.ts';
import type { LogExecutor } from './embed.ts';
import { DEFAULT_EMOJIS, type EmojiSet } from './emoji.ts';
import { isIgnored, resolveDestination } from './routing.ts';

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

export function createServerlogListener(deps: ServerlogDeps): EventListener<ServerlogConfig> {
  return {
    types: SERVERLOG_EVENT_TYPES,
    async handler(event: ProtonEvent, ctx: ModuleContext<ServerlogConfig>): Promise<void> {
      if (!ctx.config.enabled) return;

      if (event.type === 'audit.entry') {
        await onAudit(deps, ctx, event);
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
  // with the case id and the module attached. The second is strictly better, so the first is
  // dropped rather than logged alongside it.
  const byProton = deps.botUserId !== undefined && entry.actorId === deps.botUserId;

  for (const spec of byProton ? [] : specsForAuditAction(entry.actionType)) {
    await emit(deps, ctx, spec, {
      entity: null,
      audit: entry,
      naturalKey: entry.entryId,
      occurredAt: event.occurredAt,
    });
  }

  if (!entry.targetId || !deps.correlation) return;

  for (const spec of entitySpecsForAuditAction(entry.actionType)) {
    const pending = await deps.correlation.takePending(
      entry.guildId,
      entry.actionType,
      entry.targetId,
    );

    if (pending) {
      if (spec.suppressWhenCorrelated) continue;

      await emit(deps, ctx, spec, {
        entity: pending.entity,
        audit: entry,
        cached: cachedOf(pending),
        naturalKey: keyOf(spec, pending.entity, entry),
        occurredAt: pending.occurredAt,
      });
      continue;
    }

    await deps.correlation.putAudit(entry.guildId, entry.actionType, entry.targetId, entry);
  }
}

async function onEntity(
  deps: ServerlogDeps,
  ctx: ModuleContext<ServerlogConfig>,
  event: ProtonEvent,
): Promise<void> {
  const facts = factsOf(event);

  if (deps.botUserId && facts.actorId === deps.botUserId) return;
  if (isIgnored(ctx.config, facts)) return;

  const cached = await readCache(deps, ctx.guildId, event);

  for (const spec of specsForEvent(event.type)) {
    if (spec.primary === 'immediate') {
      await emit(deps, ctx, spec, {
        entity: event.payload,
        audit: null,
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
    let correlated: AuditEntry | null = null;

    for (const actionType of actions) {
      correlated = await deps.correlation.takeAudit(guildId, actionType, targetId);
      if (correlated) break;
    }

    if (correlated) {
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

  // No audit entry turned up. That is the normal path for a voluntary leave, a self-deleted
  // message or an expiring invite, so the log still goes out — with an unknown executor.
  await emit(deps, ctx, spec, {
    entity: pending.entity,
    audit: null,
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
  cached?: CachedMessage | null;
  naturalKey: string;
  occurredAt: number;
}

async function emit(
  deps: ServerlogDeps,
  ctx: ModuleContext<ServerlogConfig>,
  spec: LogEventSpec,
  input: EmitInput,
): Promise<void> {
  const destination = resolveDestination(ctx.config, spec);
  if (!destination) return;

  const executor = await resolveExecutor(deps, input.audit);

  const rendered = spec.render({
    guildId: ctx.guildId,
    entity: input.entity,
    audit: input.audit,
    cached: input.cached,
    executor,
    occurredAt: input.occurredAt,
    emojis: deps.emojis ?? DEFAULT_EMOJIS,
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
  audit: AuditEntry | null,
): Promise<LogExecutor | null> {
  const actorId = audit?.actorId;
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
          `Proton is logging more than ${LOG_BURST_LIMIT} events a minute in this server, so ` +
          'detailed logs are paused until the burst passes. Nothing else has changed.',
        allowedMentions: { parse: [] },
      },
    });

    return true;
  }

  return result.count > LOG_BURST_LIMIT;
}
