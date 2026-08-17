import type { Redis } from 'ioredis';
import { z } from 'zod';
import { snowflakeSchema } from '../actions/payloads.ts';

export const MESSAGE_CACHE_PREFIX = 'proton:msg';

export const MESSAGE_CACHE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const MESSAGE_CACHE_MIN_TTL_MS = 60 * 60 * 1000;
export const MESSAGE_CACHE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MESSAGE_CACHE_CONTENT_MAX = 2000;
export const MESSAGE_CACHE_ATTACHMENTS_MAX = 10;

export const MESSAGE_CACHE_SCAN_COUNT = 500;

export const cachedAttachmentSchema = z.object({
  filename: z.string().max(256),
  url: z.string().max(1024),
});

export const cachedMessageSchema = z.object({
  authorId: snowflakeSchema,
  authorBot: z.boolean().default(false),
  channelId: snowflakeSchema,
  content: z.string().max(MESSAGE_CACHE_CONTENT_MAX),
  attachments: z.array(cachedAttachmentSchema).max(MESSAGE_CACHE_ATTACHMENTS_MAX).default([]),
  createdAt: z.number().int(),
});

export type CachedAttachment = z.infer<typeof cachedAttachmentSchema>;
export type CachedMessage = z.infer<typeof cachedMessageSchema>;

export interface MessageContentCache {
  put(guildId: string, messageId: string, message: CachedMessage, ttlMs: number): Promise<void>;

  get(guildId: string, messageId: string): Promise<CachedMessage | null>;

  getMany(guildId: string, messageIds: readonly string[]): Promise<Map<string, CachedMessage>>;

  delete(guildId: string, messageId: string): Promise<void>;

  purge(guildId: string): Promise<number>;
}

export function clampCacheTtl(ttlMs: number): number {
  return Math.min(MESSAGE_CACHE_MAX_TTL_MS, Math.max(MESSAGE_CACHE_MIN_TTL_MS, Math.trunc(ttlMs)));
}

// Attachment URLs, never bytes: Discord's attachment CDN links expire, so a delete log may show a
// dead link — which is still better than storing the file or an I2 violation to fetch it.
export function toCachedMessage(payload: unknown): CachedMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as Record<string, unknown>;

  const author = message.author as Record<string, unknown> | undefined;
  const parsed = cachedMessageSchema.safeParse({
    authorId: author?.id,
    authorBot: author?.bot === true,
    channelId: message.channel_id,
    content:
      typeof message.content === 'string'
        ? message.content.slice(0, MESSAGE_CACHE_CONTENT_MAX)
        : '',
    attachments: Array.isArray(message.attachments)
      ? message.attachments.slice(0, MESSAGE_CACHE_ATTACHMENTS_MAX).map((raw) => {
          const attachment = raw as Record<string, unknown>;
          return {
            filename: String(attachment.filename ?? 'file').slice(0, 256),
            url: String(attachment.url ?? '').slice(0, 1024),
          };
        })
      : [],
    createdAt: typeof message.timestamp === 'string' ? Date.parse(message.timestamp) || 0 : 0,
  });

  return parsed.success ? parsed.data : null;
}

export interface RedisMessageContentCacheOptions {
  prefix?: string;
  scanCount?: number;
}

export class RedisMessageContentCache implements MessageContentCache {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #scanCount: number;

  constructor(redis: Redis, options: RedisMessageContentCacheOptions = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? MESSAGE_CACHE_PREFIX;
    this.#scanCount = options.scanCount ?? MESSAGE_CACHE_SCAN_COUNT;
  }

  #key(guildId: string, messageId: string): string {
    return `${this.#prefix}:${guildId}:${messageId}`;
  }

  async put(
    guildId: string,
    messageId: string,
    message: CachedMessage,
    ttlMs: number,
  ): Promise<void> {
    await this.#redis.set(
      this.#key(guildId, messageId),
      JSON.stringify(message),
      'PX',
      clampCacheTtl(ttlMs),
    );
  }

  async get(guildId: string, messageId: string): Promise<CachedMessage | null> {
    return parse(await this.#redis.get(this.#key(guildId, messageId)));
  }

  async getMany(
    guildId: string,
    messageIds: readonly string[],
  ): Promise<Map<string, CachedMessage>> {
    const found = new Map<string, CachedMessage>();
    if (messageIds.length === 0) return found;

    const raw = await this.#redis.mget(messageIds.map((id) => this.#key(guildId, id)));

    for (const [index, value] of raw.entries()) {
      const messageId = messageIds[index];
      const message = parse(value);
      if (messageId && message) found.set(messageId, message);
    }

    return found;
  }

  async delete(guildId: string, messageId: string): Promise<void> {
    await this.#redis.del(this.#key(guildId, messageId));
  }

  async purge(guildId: string): Promise<number> {
    const match = `${this.#prefix}:${guildId}:*`;
    let cursor = '0';
    let removed = 0;

    do {
      const [next, keys] = await this.#redis.scan(cursor, 'MATCH', match, 'COUNT', this.#scanCount);
      cursor = next;

      if (keys.length > 0) {
        await this.#redis.unlink(...keys);
        removed += keys.length;
      }
    } while (cursor !== '0');

    return removed;
  }
}

function parse(raw: string | null): CachedMessage | null {
  if (raw === null) return null;

  try {
    const result = cachedMessageSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
