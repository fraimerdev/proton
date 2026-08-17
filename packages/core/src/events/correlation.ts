import type { Redis } from 'ioredis';
import { type AuditEntry, auditEntrySchema } from './audit-log.ts';

export const CORRELATION_PREFIX = 'proton:correlate';

export const CORRELATION_TTL_MS = 15_000;

export const CORRELATION_GRACE_MS = 2_000;

export interface PendingLog {
  logKey: string;
  entity: unknown;
  guildId: string;
  occurredAt: number;

  // A self-deleted message has no audit entry, so it renders from the flush path — by which time
  // the cache entry is gone. What was read is carried here rather than read twice.
  cached?: unknown;
}

export interface CorrelationStore {
  putAudit(guildId: string, actionType: number, targetId: string, entry: AuditEntry): Promise<void>;

  takeAudit(guildId: string, actionType: number, targetId: string): Promise<AuditEntry | null>;

  putPending(
    guildId: string,
    actionType: number,
    targetId: string,
    pending: PendingLog,
  ): Promise<void>;

  takePending(guildId: string, actionType: number, targetId: string): Promise<PendingLog | null>;
}

export interface CorrelationStoreOptions {
  prefix?: string;
  ttlMs?: number;
}

export class RedisCorrelationStore implements CorrelationStore {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlMs: number;

  constructor(redis: Redis, options: CorrelationStoreOptions = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? CORRELATION_PREFIX;
    this.#ttlMs = options.ttlMs ?? CORRELATION_TTL_MS;
  }

  #key(side: 'audit' | 'entity', guildId: string, actionType: number, targetId: string): string {
    return `${this.#prefix}:${side}:${guildId}:${actionType}:${targetId}`;
  }

  async putAudit(
    guildId: string,
    actionType: number,
    targetId: string,
    entry: AuditEntry,
  ): Promise<void> {
    await this.#redis.set(
      this.#key('audit', guildId, actionType, targetId),
      JSON.stringify(entry),
      'PX',
      this.#ttlMs,
    );
  }

  async takeAudit(
    guildId: string,
    actionType: number,
    targetId: string,
  ): Promise<AuditEntry | null> {
    // GETDEL, not GET then DEL: the entity handler and the flush job race for the same row, and
    // only one of them may render the log.
    const raw = await this.#redis.getdel(this.#key('audit', guildId, actionType, targetId));
    if (raw === null) return null;

    const parsed = auditEntrySchema.safeParse(safeJson(raw));
    return parsed.success ? parsed.data : null;
  }

  async putPending(
    guildId: string,
    actionType: number,
    targetId: string,
    pending: PendingLog,
  ): Promise<void> {
    await this.#redis.set(
      this.#key('entity', guildId, actionType, targetId),
      JSON.stringify(pending),
      'PX',
      this.#ttlMs,
    );
  }

  async takePending(
    guildId: string,
    actionType: number,
    targetId: string,
  ): Promise<PendingLog | null> {
    const raw = await this.#redis.getdel(this.#key('entity', guildId, actionType, targetId));
    if (raw === null) return null;

    const value = safeJson(raw);
    return isPendingLog(value) ? value : null;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPendingLog(value: unknown): value is PendingLog {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.logKey === 'string' &&
    typeof candidate.guildId === 'string' &&
    typeof candidate.occurredAt === 'number'
  );
}
