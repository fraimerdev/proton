import { snowflakeSchema, toResolvedMessage } from '@proton/core';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { ModerationConfig } from '../config.ts';
import { clipStored } from '../reports/evidence.ts';
import { caseAttachmentOf } from './snapshot.ts';
import { type BufferedMessage, caseAttachmentsSchema, type MessageHistoryBuffer } from './store.ts';

export const HISTORY_PREFIX = 'proton:moderation:history';

export const HISTORY_WINDOW_MS = 60 * 60_000;

export const HISTORY_DELETED_MS = 30 * 60_000;

export const HISTORY_PER_CHANNEL = 5;

export const HISTORY_CONTENT_MAX = 2000;

const SCAN_COUNT = 500;

export function historyKey(guildId: string, userId: string): string {
  return `${HISTORY_PREFIX}:${guildId}:${userId}`;
}

export function historyMessageKey(guildId: string, channelId: string, messageId: string): string {
  return `${HISTORY_PREFIX}:${guildId}:message:${channelId}:${messageId}`;
}

export function historyDeletedKey(guildId: string, channelId: string, messageId: string): string {
  return `${HISTORY_PREFIX}:${guildId}:deleted:${channelId}:${messageId}`;
}

export function historyPattern(guildId: string): string {
  return `${HISTORY_PREFIX}:${guildId}:*`;
}

export const bufferedMessageSchema = z.object({
  messageId: z.string(),
  channelId: z.string(),
  authorId: z.string(),
  content: z.string(),
  attachments: caseAttachmentsSchema,
  createdAt: z.number(),
  deletedAt: z.number().nullable(),
}) satisfies z.ZodType<BufferedMessage>;

function parseStored(raw: string): BufferedMessage | null {
  try {
    const parsed = bufferedMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function historyExpiry(message: Pick<BufferedMessage, 'createdAt' | 'deletedAt'>): number {
  const live = message.createdAt + HISTORY_WINDOW_MS;
  return message.deletedAt === null ? live : Math.min(live, message.deletedAt + HISTORY_DELETED_MS);
}

function newestFirst(a: BufferedMessage, b: BufferedMessage): number {
  return (
    b.createdAt - a.createdAt ||
    b.messageId.length - a.messageId.length ||
    b.messageId.localeCompare(a.messageId)
  );
}

export function retainHistory(
  messages: readonly BufferedMessage[],
  now: number,
): BufferedMessage[] {
  const byChannel = new Map<string, BufferedMessage[]>();

  for (const message of messages) {
    if (historyExpiry(message) <= now) continue;
    const list = byChannel.get(message.channelId) ?? [];
    list.push(message);
    byChannel.set(message.channelId, list);
  }

  const kept = [...byChannel.values()].flatMap((list) =>
    list.sort(newestFirst).slice(0, HISTORY_PER_CHANNEL),
  );

  return kept.sort((a, b) => newestFirst(b, a));
}

export class RedisMessageHistoryBuffer implements MessageHistoryBuffer {
  readonly #redis: Redis;
  readonly #now: () => number;

  constructor(redis: Redis, options: { now?: () => number } = {}) {
    this.#redis = redis;
    this.#now = options.now ?? Date.now;
  }

  async record(guildId: string, message: BufferedMessage): Promise<void> {
    const now = this.#now();
    // Creates and deletes arrive on separate streams, so the delete may already have been seen.
    const seen = Number(
      await this.#redis.get(historyDeletedKey(guildId, message.channelId, message.messageId)),
    );

    const stored: BufferedMessage = {
      ...message,
      content: clipStored(message.content, HISTORY_CONTENT_MAX),
      deletedAt: message.deletedAt ?? (seen > 0 ? seen : null),
    };

    const expiresAt = historyExpiry(stored);
    if (expiresAt <= now) return;

    const key = historyKey(guildId, stored.authorId);
    await this.#redis.hset(key, stored.messageId, JSON.stringify(stored));
    if (stored.deletedAt === null) {
      await this.#redis.set(
        historyMessageKey(guildId, stored.channelId, stored.messageId),
        stored.authorId,
        'PX',
        Math.max(1, expiresAt - now),
      );
    }
    await this.#prune(key, now);
  }

  async markDeleted(
    guildId: string,
    channelId: string,
    messageId: string,
    at: number,
  ): Promise<void> {
    await this.#redis.set(
      historyDeletedKey(guildId, channelId, messageId),
      String(at),
      'PX',
      HISTORY_DELETED_MS,
      'NX',
    );

    const pointer = historyMessageKey(guildId, channelId, messageId);
    const authorId = await this.#redis.get(pointer);
    if (authorId === null) return;

    const key = historyKey(guildId, authorId);
    const raw = await this.#redis.hget(key, messageId);
    const message = raw === null ? null : parseStored(raw);

    if (message && message.deletedAt === null) {
      await this.#redis.hset(key, messageId, JSON.stringify({ ...message, deletedAt: at }));
    }

    await this.#redis.del(pointer);
    await this.#prune(key, this.#now());
  }

  async recent(guildId: string, userId: string, now: number): Promise<BufferedMessage[]> {
    const fields = await this.#redis.hgetall(historyKey(guildId, userId));
    return retainHistory(this.#parse(fields), now);
  }

  async purge(guildId: string): Promise<void> {
    let cursor = '0';

    do {
      const [next, keys] = await this.#redis.scan(
        cursor,
        'MATCH',
        historyPattern(guildId),
        'COUNT',
        SCAN_COUNT,
      );
      if (keys.length > 0) await this.#redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }

  #parse(fields: Record<string, string>): BufferedMessage[] {
    return Object.values(fields).flatMap((raw) => {
      const message = parseStored(raw);
      return message ? [message] : [];
    });
  }

  async #prune(key: string, now: number): Promise<void> {
    const fields = await this.#redis.hgetall(key);
    const kept = retainHistory(this.#parse(fields), now);
    const keep = new Set(kept.map((message) => message.messageId));

    const dropped = Object.keys(fields).filter((field) => !keep.has(field));
    if (dropped.length > 0) await this.#redis.hdel(key, ...dropped);

    if (kept.length === 0) {
      await this.#redis.del(key);
      return;
    }

    const last = Math.max(...kept.map(historyExpiry));
    await this.#redis.pexpire(key, Math.max(1, last - now));
  }
}

export function historyEnabled(config: Pick<ModerationConfig, 'enabled' | 'punish'>): boolean {
  return config.enabled && config.punish.messageHistory;
}

export function bufferedFromRaw(
  raw: unknown,
  now: number,
): { guildId: string; message: BufferedMessage } | null {
  const guildId = snowflakeSchema.safeParse((raw as { guild_id?: unknown } | null)?.guild_id);
  if (!guildId.success) return null;

  const message = toResolvedMessage(raw);
  if (!message?.author || message.author.bot || message.webhookId !== null) return null;

  const content = message.content !== '' ? message.content : (message.snapshotContent ?? '');
  if (content === '' && message.attachments.length === 0) return null;

  return {
    guildId: guildId.data,
    message: {
      messageId: message.id,
      channelId: message.channelId,
      authorId: message.author.id,
      content: clipStored(content, HISTORY_CONTENT_MAX),
      attachments: message.attachments.map(caseAttachmentOf),
      createdAt: message.createdAt ?? now,
      deletedAt: null,
    },
  };
}

const deletedPayloadSchema = z.object({
  id: snowflakeSchema,
  channel_id: snowflakeSchema,
  guild_id: snowflakeSchema,
});

export async function recordCreated(
  buffer: MessageHistoryBuffer,
  config: Pick<ModerationConfig, 'enabled' | 'punish'>,
  payload: unknown,
  now: number,
): Promise<boolean> {
  if (!historyEnabled(config)) return false;

  const read = bufferedFromRaw(payload, now);
  if (!read || historyExpiry(read.message) <= now) return false;

  await buffer.record(read.guildId, read.message);
  return true;
}

export async function recordDeleted(
  buffer: MessageHistoryBuffer,
  config: Pick<ModerationConfig, 'enabled' | 'punish'>,
  payload: unknown,
  now: number,
): Promise<boolean> {
  if (!historyEnabled(config)) return false;

  const parsed = deletedPayloadSchema.safeParse(payload);
  if (!parsed.success) return false;

  await buffer.markDeleted(parsed.data.guild_id, parsed.data.channel_id, parsed.data.id, now);
  return true;
}

export async function purgeGuild(buffer: MessageHistoryBuffer, guildId: string): Promise<void> {
  await buffer.purge(guildId);
}
