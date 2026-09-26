import type { Redis } from 'ioredis';
import type { z } from 'zod';

export const REPORT_ACTION_MAILBOX_PREFIX = 'proton:moderation:report-action';

const DEFAULT_TTL_MS = 120_000;

export class RedisMailbox<T> {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #schema: z.ZodType<T>;
  readonly #ttlMs: number;

  constructor(redis: Redis, options: { prefix: string; schema: z.ZodType<T>; ttlMs?: number }) {
    this.#redis = redis;
    this.#prefix = options.prefix;
    this.#schema = options.schema;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  #mailbox(id: string): string {
    return `${this.#prefix}:mailbox:${id}`;
  }

  // BLPOP consumes the list entry, so a second wait on the same id is answered from this copy.
  #kept(id: string): string {
    return `${this.#prefix}:done:${id}`;
  }

  #parse(raw: string | null | undefined): T | null {
    if (raw === null || raw === undefined) return null;

    try {
      const parsed = this.#schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async recall(id: string): Promise<T | null> {
    return this.#parse(await this.#redis.get(this.#kept(id)));
  }

  async answer(id: string, value: T): Promise<void> {
    const body = JSON.stringify(value);

    // The kept copy first: a waiter woken by the list entry may ask for it immediately.
    await this.#redis.set(this.#kept(id), body, 'PX', this.#ttlMs);
    await this.#redis
      .multi()
      .rpush(this.#mailbox(id), body)
      .pexpire(this.#mailbox(id), this.#ttlMs)
      .exec();
  }

  async wait(id: string, timeoutMs: number): Promise<T | null> {
    const kept = await this.recall(id);
    if (kept !== null) return kept;

    // BLPOP holds its connection for the whole timeout, and the shared client has other work.
    const blocking = this.#redis.duplicate();

    try {
      const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      const popped = await blocking.blpop(this.#mailbox(id), seconds);

      return this.#parse(popped?.[1]) ?? (await this.recall(id));
    } finally {
      await blocking.quit().catch(() => undefined);
    }
  }
}
