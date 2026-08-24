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
