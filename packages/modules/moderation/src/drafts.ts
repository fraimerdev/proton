import { CASE_ID_ALPHABET } from '@proton/core';
import type { Redis } from 'ioredis';
import type { z } from 'zod';

export const DRAFT_PREFIX = 'proton:moderation:draft';
export const LOCK_PREFIX = 'proton:moderation';

const UNLOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export const DRAFT_TTL_MS = 15 * 60 * 1000;
export const REACTION_DRAFT_TTL_MS = 60 * 60 * 1000;
export const DRAFT_OUTCOME_TTL_MS = 15 * 60 * 1000;

export const DRAFT_ID_LENGTH = 10;
export const DRAFT_ID_PATTERN = /^[A-Za-z0-9]{10}$/;

const BYTE_CEILING = 256 - (256 % CASE_ID_ALPHABET.length);

export function newDraftId(): string {
  let id = '';
  const buffer = new Uint8Array(DRAFT_ID_LENGTH);

  while (id.length < DRAFT_ID_LENGTH) {
    crypto.getRandomValues(buffer);

    for (const byte of buffer) {
      if (byte >= BYTE_CEILING) continue;

      id += CASE_ID_ALPHABET[byte % CASE_ID_ALPHABET.length];
      if (id.length === DRAFT_ID_LENGTH) break;
    }
  }

  return id;
}

export interface DraftStore {
  put(guildId: string, id: string, value: unknown, ttlMs: number): Promise<void>;
  get<T>(guildId: string, id: string, schema: z.ZodType<T>): Promise<T | null>;
  take<T>(guildId: string, id: string, schema: z.ZodType<T>): Promise<T | null>;
  putOutcome(guildId: string, id: string, value: unknown, ttlMs?: number): Promise<void>;
  getOutcome<T>(guildId: string, id: string, schema: z.ZodType<T>): Promise<T | null>;
  lock(key: string, token: string, ttlMs: number): Promise<boolean>;
  unlock(key: string, token: string): Promise<void>;
}

export function draftKey(guildId: string, id: string, prefix: string = DRAFT_PREFIX): string {
  return `${prefix}:${guildId}:${id}`;
}

export function draftOutcomeKey(
  guildId: string,
  id: string,
  prefix: string = DRAFT_PREFIX,
): string {
  return `${draftKey(guildId, id, prefix)}:done`;
}

export function parseDraft<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

function ttl(ms: number): number {
  return Math.max(1, Math.floor(ms));
}

export class RedisDraftStore implements DraftStore {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #lockPrefix: string;

  constructor(redis: Redis, options: { prefix?: string; lockPrefix?: string } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? DRAFT_PREFIX;
    this.#lockPrefix = options.lockPrefix ?? LOCK_PREFIX;
  }

  async lock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const set = await this.#redis.set(`${this.#lockPrefix}:${key}`, token, 'PX', ttl(ttlMs), 'NX');
    return set === 'OK';
  }

  async unlock(key: string, token: string): Promise<void> {
    await this.#redis.eval(UNLOCK_SCRIPT, 1, `${this.#lockPrefix}:${key}`, token);
  }

  async put(guildId: string, id: string, value: unknown, ttlMs: number): Promise<void> {
    await this.#redis.set(
      draftKey(guildId, id, this.#prefix),
      JSON.stringify(value),
      'PX',
      ttl(ttlMs),
    );
  }

  async get<T>(guildId: string, id: string, schema: z.ZodType<T>): Promise<T | null> {
    return parseDraft(await this.#redis.get(draftKey(guildId, id, this.#prefix)), schema);
  }

  async take<T>(guildId: string, id: string, schema: z.ZodType<T>): Promise<T | null> {
    return parseDraft(await this.#redis.getdel(draftKey(guildId, id, this.#prefix)), schema);
  }

  async putOutcome(
    guildId: string,
    id: string,
    value: unknown,
    ttlMs: number = DRAFT_OUTCOME_TTL_MS,
  ): Promise<void> {
    await this.#redis.set(
      draftOutcomeKey(guildId, id, this.#prefix),
      JSON.stringify(value),
      'PX',
      ttl(ttlMs),
    );
  }

  async getOutcome<T>(guildId: string, id: string, schema: z.ZodType<T>): Promise<T | null> {
    return parseDraft(await this.#redis.get(draftOutcomeKey(guildId, id, this.#prefix)), schema);
  }
}
