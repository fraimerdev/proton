import { snowflakeSchema } from '@proton/core';
import type { Redis } from 'ioredis';
import { z } from 'zod';

export const HONEYPOT_LOCK_PREFIX = 'proton:honeypot:tripped';

export const HONEYPOT_NOTICE_PREFIX = 'proton:honeypot:notice';

export const HONEYPOT_LOCK_TTL_MS = 60_000;

export function lockKey(guildId: string, userId: string, prefix = HONEYPOT_LOCK_PREFIX): string {
  return `${prefix}:${guildId}:${userId}`;
}

export interface HoneypotLock {
  // True for the caller that won it. A burst of messages produces one winner and one action.
  claim(guildId: string, userId: string, ttlMs: number): Promise<boolean>;
}

export class RedisHoneypotLock implements HoneypotLock {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: { keyPrefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? HONEYPOT_LOCK_PREFIX;
  }

  async claim(guildId: string, userId: string, ttlMs: number): Promise<boolean> {
    const won = await this.#redis.set(
      lockKey(guildId, userId, this.#prefix),
      '1',
      'PX',
      Math.max(1, Math.floor(ttlMs)),
      'NX',
    );

    return won === 'OK';
  }
}

export function noticeKey(guildId: string, prefix = HONEYPOT_NOTICE_PREFIX): string {
  return `${prefix}:${guildId}`;
}

export const noticeRecordSchema = z.object({
  messageId: snowflakeSchema,
  postedAt: z.number().int().nonnegative(),
});

export type NoticeRecord = z.infer<typeof noticeRecordSchema>;

// Every notice a guild has, keyed by the channel it sits in. One key per guild rather than one per
// channel: the reconcile has to know which notices exist for channels that are no longer honeypots,
// and SCANning a key space to find them is not something a save should do.
export const noticeBookSchema = z.record(snowflakeSchema, noticeRecordSchema);

export type NoticeBook = z.infer<typeof noticeBookSchema>;

export interface NoticeStore {
  get(guildId: string): Promise<NoticeBook>;

  put(guildId: string, book: NoticeBook): Promise<void>;
}

export class RedisNoticeStore implements NoticeStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: { keyPrefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.keyPrefix ?? HONEYPOT_NOTICE_PREFIX;
  }

  async get(guildId: string): Promise<NoticeBook> {
    const raw = await this.#redis.get(noticeKey(guildId, this.#prefix));
    if (raw === null) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }

    const book = noticeBookSchema.safeParse(parsed);
    return book.success ? book.data : {};
  }

  async put(guildId: string, book: NoticeBook): Promise<void> {
    const key = noticeKey(guildId, this.#prefix);

    if (Object.keys(book).length === 0) {
      await this.#redis.del(key);
      return;
    }

    await this.#redis.set(key, JSON.stringify(book));
  }
}

export const HONEYPOT_STATS_PREFIX = 'proton:honeypot:stats';

export const HONEYPOT_CAUGHT_PREFIX = 'proton:honeypot:caught';

export const HONEYPOT_REFRESH_PREFIX = 'proton:honeypot:refresh';

// A month. The lifetime total is a separate counter so this trim never rewrites the button.
export const CAUGHT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const RECENT_SHOWN = 8;

export interface CaughtEntry {
  userId: string;
  action: string;
  at: number;
}

// Keyed on the message: RESUME redelivers one long after the burst lock let go, and without this
// the same member lands on a public number twice.
export interface CaughtInput extends CaughtEntry {
  messageId: string;
}

export interface HoneypotStats {
  total: number;
  lastDay: number;
  lastWeek: number;

  byAction: Record<string, number>;
  recent: CaughtEntry[];
}

export interface HoneypotStatsStore {
  record(guildId: string, channelId: string, entry: CaughtInput): Promise<number>;

  read(guildId: string, channelId: string, now: number): Promise<HoneypotStats>;

  total(guildId: string, channelId: string): Promise<number>;

  claimRefresh(guildId: string, channelId: string, ttlMs: number): Promise<boolean>;
}

function scoped(prefix: string, guildId: string, channelId: string): string {
  return `${prefix}:${guildId}:${channelId}`;
}

// WITHSCORES answers one flat array of member, score, member, score — the timestamp comes off the
// score rather than the member so the member can stay keyed on the message that produced it.
function pairs(flat: readonly string[]): CaughtEntry[] {
  const entries: CaughtEntry[] = [];

  for (let index = 0; index + 1 < flat.length; index += 2) {
    const entry = parseEntry(flat[index] ?? '', flat[index + 1] ?? '');
    if (entry) entries.push(entry);
  }

  return entries;
}

function parseEntry(member: string, score: string): CaughtEntry | null {
  const [, userId, action] = member.split(':');
  if (!userId || !action) return null;

  const at = Number(score);
  return Number.isFinite(at) ? { userId, action, at } : null;
}

export class RedisHoneypotStatsStore implements HoneypotStatsStore {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async record(guildId: string, channelId: string, entry: CaughtInput): Promise<number> {
    const stats = scoped(HONEYPOT_STATS_PREFIX, guildId, channelId);
    const caught = scoped(HONEYPOT_CAUGHT_PREFIX, guildId, channelId);

    // NX first, and its answer is the gate: the counters below are what the notice shows, and a
    // redelivered message must not move them a second time.
    const added = await this.#redis.zadd(
      caught,
      'NX',
      entry.at,
      `${entry.messageId}:${entry.userId}:${entry.action}`,
    );

    if (Number(added) === 0) return this.total(guildId, channelId);

    const replies = await this.#redis
      .multi()
      .hincrby(stats, 'total', 1)
      .hincrby(stats, `action:${entry.action}`, 1)
      .zremrangebyscore(caught, '-inf', entry.at - CAUGHT_RETENTION_MS)
      .exec();

    const counted = replies?.[0]?.[1];
    return typeof counted === 'number' ? counted : Number(counted ?? 0);
  }

  async total(guildId: string, channelId: string): Promise<number> {
    const raw = await this.#redis.hget(scoped(HONEYPOT_STATS_PREFIX, guildId, channelId), 'total');

    return raw === null ? 0 : Number(raw) || 0;
  }

  async read(guildId: string, channelId: string, now: number): Promise<HoneypotStats> {
    const stats = scoped(HONEYPOT_STATS_PREFIX, guildId, channelId);
    const caught = scoped(HONEYPOT_CAUGHT_PREFIX, guildId, channelId);

    const [fields, day, week, recent] = await Promise.all([
      this.#redis.hgetall(stats),
      this.#redis.zcount(caught, now - 24 * 60 * 60 * 1000, '+inf'),
      this.#redis.zcount(caught, now - 7 * 24 * 60 * 60 * 1000, '+inf'),
      this.#redis.zrevrange(caught, 0, RECENT_SHOWN - 1, 'WITHSCORES'),
    ]);

    const byAction: Record<string, number> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (!key.startsWith('action:')) continue;
      byAction[key.slice('action:'.length)] = Number(value) || 0;
    }

    return {
      total: Number(fields.total) || 0,
      lastDay: day,
      lastWeek: week,
      byAction,
      recent: pairs(recent),
    };
  }

  async claimRefresh(guildId: string, channelId: string, ttlMs: number): Promise<boolean> {
    const won = await this.#redis.set(
      scoped(HONEYPOT_REFRESH_PREFIX, guildId, channelId),
      '1',
      'PX',
      Math.max(1, Math.floor(ttlMs)),
      'NX',
    );

    return won === 'OK';
  }
}
